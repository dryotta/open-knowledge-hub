# OKH — Tool Metadata as Resource Files

**Status:** Approved design (pre-implementation)
**Date:** 2026-07-09
**Branch:** `feat/resources-restructure` (extends the prompt-templates refactor)
**Relates to:** `2026-07-09-okh-prompt-templates-tools-only-design.md`

---

## 1. Summary

Move every MCP tool's **descriptive text** — title, agent-facing description, and
per-argument descriptions — out of code and into per-tool resource files, so all 8
tools can be reviewed and edited for consistency. The Zod argument **schemas**
(types/enums/validation) stay in code, consolidated into one file. A loader binds
text ↔ schema at registration and fails fast if they drift.

This finishes the "all MCP-emitted text comes from `resources/`" direction: after
the prompt-templates refactor, tool metadata was the last agent-facing text still
hardcoded (and split inconsistently: flows in `src/prompts/meta.ts`, operational
tools inline in `src/server/tools.ts`).

### Goals

1. Each tool's title/description/arg-descriptions live in `resources/tool-meta/<name>.md`
   (frontmatter + markdown body), editable without touching TypeScript.
2. One consolidated schema surface (`src/server/toolSchemas.ts`) mirrors the one
   resource directory — text there, schema here.
3. A registration-time binding enforces that every schema argument has a description
   and every description maps to a real argument (consistency guaranteed by a test).
4. No behavior change: titles/descriptions are ported verbatim, so tool routing is
   unchanged.

### Non-goals

- No change to tool argument schemas, validation, handlers, or annotations.
- No change to the prompt templates (`resources/prompts/`) or module-type/shared skills.
- No new dependency (reuses `yaml` via `parseFrontmatter` and the existing
  `renderString` template engine).

---

## 2. Resource layout — `resources/tool-meta/<name>.md`

One file per tool (8 total): `inspect.md`, `add.md`, `sync.md`, `config.md`,
`onboard.md`, `ask.md`, `context.md`, `run.md`.

Format (mirrors the `SKILL.md` convention): YAML frontmatter with `title` and an
`args` map (argument name → description); the markdown **body** is the tool
description.

```markdown
---
title: Inspect containers/modules
args:
  container: Container name to inspect.
  module: Module path within the container.
---
List registered containers (no args), a container's modules + status (container),
or a module's items (container + module).
```

- Tools with no arguments (`onboard`) omit `args` (treated as `{}`).
- `config`'s body contains a `{{var:configKeys}}` placeholder (dynamic list of known
  config keys), resolved at load time via the template engine.
- All text is ported **verbatim** from the current `flowMeta`/`argDescriptions`
  (flows) and the inline strings in `tools.ts` (operational tools).

---

## 3. Loader + binding — `src/server/toolMeta.ts` (new)

```ts
import type { ZodRawShape } from "zod";
import type { RenderContext } from "../prompts/templates.js";

export interface ToolMeta { title: string; description: string; args: Record<string, string>; }

/** Load resources/tool-meta/<name>.md: frontmatter title + args, body rendered as description. */
export async function loadToolMeta(name: string, ctx?: RenderContext): Promise<ToolMeta>;

/** Parse + validate + render raw tool-meta text (unit-testable without files). */
export async function parseToolMeta(name: string, raw: string, ctx?: RenderContext): Promise<ToolMeta>;

/** Apply arg descriptions to a Zod shape; throw if shape keys and arg keys differ. */
export function describeShape(shape: ZodRawShape, args: Record<string, string>): ZodRawShape;
```

- **Resolution:** `resources/tool-meta/` via `new URL("../../resources/tool-meta/…", import.meta.url)` (same pattern as `templates.ts`; works from `src` tsx and `dist`). Cached by file.
- **`loadToolMeta`** = read the file → `parseToolMeta(name, raw, ctx)`. Splitting parse from I/O lets the validation be unit-tested with crafted strings (no fixture files).
- **`parseToolMeta`:** `parseFrontmatter(raw)` → validate → render body via
  `renderString(body, ctx)` (so `config` resolves `{{var:configKeys}}`; other tools
  have no tokens and pass through unchanged) → return `{ title, description, args }`.
- **Validation (fail-fast, includes the tool name in the error):**
  - `title` is a non-empty string.
  - body (post-render, trimmed) is non-empty.
  - `args` (if present) is an object whose values are all strings.
- **`describeShape`:** for each `shape` key apply `.describe(args[key])`; throw if the
  set of shape keys ≠ the set of `args` keys (every argument documented, no orphan
  descriptions). Returns a new shape (does not mutate the input).

---

## 4. Schemas — `src/server/toolSchemas.ts` (new)

All 8 bare Zod arg shapes (no `.describe()` — descriptions come from the resources):

```ts
import { z } from "zod";

const container = z.string().optional();
const moduleArg = z.string().optional();

export const toolShapes = {
  inspect: { container, module: moduleArg },
  add: {
    source: z.string().optional(),
    name: z.string().optional(),
    sync: z.enum(["auto", "pr"]).optional(),
    backend: z.enum(["local", "onedrive"]).optional(),
    container,
    path: z.string().optional(),
    type: z.string().min(1).optional(),
    description: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    create: z.boolean().optional(),
  },
  sync: { container, message: z.string().optional() },
  config: { set: z.record(z.string(), z.unknown()).optional() },
  onboard: {},
  ask: { container, module: moduleArg, question: z.string().optional() },
  context: { container, task: z.string().optional() },
  run: { container, module: moduleArg, skill: z.string(), input: z.string().optional() },
} as const;

export type ToolName = keyof typeof toolShapes;
```

These shapes are ported verbatim from the current inline schemas (operational) and
`flowArgShapes` (flows), minus the `.describe()` calls.

---

## 5. Registration — `src/server/tools.ts`

- `registerTools` and `registerFlowTools` become **async** (awaited by the async
  `buildServer`).
- Import `loadToolMeta`, `describeShape` from `./toolMeta.js` and `toolShapes`,
  `ToolName` from `./toolSchemas.js`. Remove the `import … from "../prompts/meta.js"`.
- A local helper builds the shared registration fields:
  ```ts
  async function toolReg(name: ToolName, ctx?: RenderContext) {
    const m = await loadToolMeta(name, ctx);
    return { title: m.title, description: m.description, inputSchema: describeShape(toolShapes[name], m.args) };
  }
  ```
- Each `server.registerTool` call uses it, keeping its own **annotations** inline:
  ```ts
  server.registerTool("add", { ...(await toolReg("add")), annotations: { openWorldHint: true } }, handler(...));
  ```
  `config` passes the render context: `await toolReg("config", { vars: { configKeys: configKeys.join(", ") } })`.
- Handlers, validation logic, `formatInspect`/`formatConfig`/etc. are unchanged.

---

## 6. Delete `src/prompts/meta.ts`

Title/description text → `resources/tool-meta/*.md`; arg descriptions → the resources'
`args`; Zod shapes → `toolSchemas.ts`. `meta.ts` (and its `FlowName`/`FlowMeta`/
`argDescriptions`/`flowMeta`/`flowArgShapes`) is imported only by `tools.ts` and is
fully superseded — delete it.

---

## 7. Tests

**Unit (`npm test`, `npm run typecheck`):**
- `test/toolMeta.test.ts` (new):
  - `loadToolMeta("inspect")` returns the ported title/description/args.
  - `loadToolMeta("config", { vars: { configKeys: "wakePhrase" } })` renders
    `{{var:configKeys}}` → the description contains `wakePhrase`.
  - `parseToolMeta` validation: a missing `title` throws; an empty body throws; a
    non-string `args` value throws (crafted raw strings, no fixture files needed).
  - `describeShape({ a: z.string() }, { a: "d" })` applies the description;
    `describeShape({ a: z.string() }, {})` and `describeShape({}, { a: "d" })` both throw.
- **Consistency test** (the payoff): iterate every `ToolName` →
  `loadToolMeta(name, name === "config" ? { vars: { configKeys: "x" } } : undefined)`
  succeeds with a non-empty title/description, and
  `describeShape(toolShapes[name], meta.args)` does not throw. This guarantees at
  test time that all 8 tools have complete, consistent metadata resources.
- `test/server.test.ts`: still asserts the 8 tool names + no prompts. Optionally
  assert a couple of representative titles/descriptions are present (ported verbatim).

**Eval:** unaffected — tool text is verbatim, so routing is unchanged. Run
`typecheck:eval` / `test:eval` / `eval:validate` and the full `npm run eval` as the
larger-change gate.

---

## 8. Risks & mitigations

- **Text/schema drift** → `describeShape` throws on arg/description mismatch; the
  consistency test exercises all 8 tools at build time.
- **Async registration ripple** → `buildServer` is already async; only `registerTools`
  /`registerFlowTools` signatures change (internal).
- **`{{…}}` false positives in a description body** → only `config` uses a token;
  single-brace JSON examples (`{ set: {…} }`) don't match the `{{ns:arg}}` grammar.
- **Verbatim port errors** → server test asserts tool names; representative
  title/description assertions catch gross porting mistakes.
- **`resources/tool-meta/` shipped** → `package.json` `files` already ships all of
  `resources`; no change needed.

---

## 9. Out of scope / deferred

- Rendering **argument** descriptions through the template engine (kept literal;
  only the description body is rendered, solely for `config`).
- Externalizing tool `annotations` (capability flags stay in code).
- Any change to the prompt templates or skills.
