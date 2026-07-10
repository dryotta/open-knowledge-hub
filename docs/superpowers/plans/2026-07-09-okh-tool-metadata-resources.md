# OKH Tool Metadata as Resource Files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every MCP tool's title/description/arg-descriptions into `resources/tool-meta/<name>.md`, consolidate the Zod arg schemas into `src/server/toolSchemas.ts`, and bind them at registration with a fail-fast consistency check.

**Architecture:** A loader (`src/server/toolMeta.ts`) reads each tool's markdown (frontmatter `title`+`args`, body=description rendered via the existing `renderString`) and a `describeShape` helper attaches arg descriptions to the code-defined Zod shapes, throwing if they don't match. `registerTools`/`registerFlowTools` become async and pull metadata by tool name. `src/prompts/meta.ts` is deleted.

**Tech Stack:** TypeScript (ESM, `import.meta.url`), Zod, Vitest v4, `yaml` (via `parseFrontmatter`), the `renderString` template engine from `src/prompts/templates.ts`.

**Spec:** `docs/superpowers/specs/2026-07-09-okh-tool-metadata-resources-design.md`

---

## File Structure

**Create:**
- `src/server/toolMeta.ts` — `parseToolMeta`, `loadToolMeta`, `describeShape`.
- `src/server/toolSchemas.ts` — `toolShapes` (all 8 bare Zod shapes) + `ToolName`.
- `resources/tool-meta/{inspect,add,sync,config,onboard,ask,context,run}.md`.
- `test/toolMeta.test.ts`.

**Modify:**
- `src/server/tools.ts` — async registration, `toolReg` helper, per-tool metadata via `toolReg`, remove `meta.ts` import.
- `src/server/index.ts` — `await registerTools(...)`.

**Delete:**
- `src/prompts/meta.ts`.

**Verification:** `npm run build`, `npm run typecheck`, `npm test` (targeted `npx vitest run <file>`), `npm run typecheck:eval`, `npm run test:eval`, `npm run eval:validate`, full `npm run build && npm run eval`.

---

## Task 1: Loader + `describeShape` (`src/server/toolMeta.ts`)

**Files:**
- Create: `src/server/toolMeta.ts`
- Test: `test/toolMeta.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/toolMeta.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseToolMeta, describeShape } from "../src/server/toolMeta.js";

describe("parseToolMeta", () => {
  it("parses title + args and renders the body as description", async () => {
    const raw = "---\ntitle: T\nargs:\n  a: desc-a\n---\nHello body.\n";
    const m = await parseToolMeta("x", raw);
    expect(m.title).toBe("T");
    expect(m.args).toEqual({ a: "desc-a" });
    expect(m.description).toBe("Hello body.");
  });
  it("renders {{var:...}} tokens in the body", async () => {
    const raw = "---\ntitle: Config\n---\nKnown keys: {{var:configKeys}}.\n";
    const m = await parseToolMeta("config", raw, { vars: { configKeys: "wakePhrase" } });
    expect(m.description).toBe("Known keys: wakePhrase.");
  });
  it("defaults args to {} when absent", async () => {
    const m = await parseToolMeta("x", "---\ntitle: T\n---\nBody.\n");
    expect(m.args).toEqual({});
  });
  it("throws on a missing title", async () => {
    await expect(parseToolMeta("x", "---\nargs: {}\n---\nBody.\n")).rejects.toThrow(/title/);
  });
  it("throws on an empty description body", async () => {
    await expect(parseToolMeta("x", "---\ntitle: T\n---\n\n")).rejects.toThrow(/description/);
  });
  it("throws on a non-string arg description", async () => {
    await expect(parseToolMeta("x", "---\ntitle: T\nargs:\n  a: 3\n---\nBody.\n")).rejects.toThrow(/arg "a"/);
  });
});

describe("describeShape", () => {
  it("applies descriptions to each field", () => {
    const shaped = describeShape({ a: z.string(), b: z.number() }, { a: "da", b: "db" });
    expect(shaped.a!.description).toBe("da");
    expect(shaped.b!.description).toBe("db");
  });
  it("throws when an arg lacks a description", () => {
    expect(() => describeShape({ a: z.string() }, {})).toThrow(/mismatch/);
  });
  it("throws on an orphan description", () => {
    expect(() => describeShape({}, { a: "da" })).toThrow(/mismatch/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/toolMeta.test.ts`
Expected: FAIL — `../src/server/toolMeta.js` does not resolve.

- [ ] **Step 3: Implement `src/server/toolMeta.ts`**

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ZodRawShape } from "zod";
import { parseFrontmatter } from "../util/frontmatter.js";
import { renderString, type RenderContext } from "../prompts/templates.js";

// resources/ sits at the package root; ../../ from src/server (tsx) and dist/server (built) both resolve there.
const TOOL_META_ROOT = new URL("../../resources/tool-meta/", import.meta.url);

export interface ToolMeta {
  title: string;
  description: string;
  args: Record<string, string>;
}

const cache = new Map<string, string>();

async function readToolMetaFile(name: string): Promise<string> {
  const abs = fileURLToPath(new URL(`${name}.md`, TOOL_META_ROOT));
  const cached = cache.get(abs);
  if (cached !== undefined) return cached;
  const text = await readFile(abs, "utf8");
  cache.set(abs, text);
  return text;
}

/** Parse + validate + render raw tool-meta text (unit-testable without files). */
export async function parseToolMeta(name: string, raw: string, ctx: RenderContext = {}): Promise<ToolMeta> {
  const { data, body } = parseFrontmatter(raw);
  const title = data.title;
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error(`tool-meta "${name}": missing or empty "title"`);
  }
  const argsRaw = data.args ?? {};
  if (typeof argsRaw !== "object" || argsRaw === null || Array.isArray(argsRaw)) {
    throw new Error(`tool-meta "${name}": "args" must be a map`);
  }
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(argsRaw as Record<string, unknown>)) {
    if (typeof v !== "string") throw new Error(`tool-meta "${name}": arg "${k}" description must be a string`);
    args[k] = v;
  }
  const description = (await renderString(body, ctx)).trim();
  if (description.length === 0) throw new Error(`tool-meta "${name}": empty description body`);
  return { title, description, args };
}

/** Load resources/tool-meta/<name>.md and parse/validate/render it. */
export async function loadToolMeta(name: string, ctx?: RenderContext): Promise<ToolMeta> {
  return parseToolMeta(name, await readToolMetaFile(name), ctx);
}

/** Apply arg descriptions to a Zod shape; throw if the shape keys and arg keys differ. */
export function describeShape(shape: ZodRawShape, args: Record<string, string>): ZodRawShape {
  const shapeKeys = Object.keys(shape).sort();
  const argKeys = Object.keys(args).sort();
  if (shapeKeys.length !== argKeys.length || shapeKeys.some((k, i) => k !== argKeys[i])) {
    throw new Error(`tool arg/description mismatch: schema=[${shapeKeys.join(",")}] descriptions=[${argKeys.join(",")}]`);
  }
  const out: ZodRawShape = {};
  for (const [k, schema] of Object.entries(shape)) {
    out[k] = schema.describe(args[k]!);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/toolMeta.test.ts && npm run build`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add src/server/toolMeta.ts test/toolMeta.test.ts
git commit -m "feat(tools): tool-meta loader (parse/validate/render) + describeShape"
```

---

## Task 2: Consolidated schemas (`src/server/toolSchemas.ts`)

**Files:**
- Create: `src/server/toolSchemas.ts`

- [ ] **Step 1: Create the file**

```ts
import { z } from "zod";

const container = z.string().optional();
const moduleArg = z.string().optional();

/** Bare Zod arg shapes for every tool; descriptions come from resources/tool-meta/<name>.md. */
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
};

export type ToolName = keyof typeof toolShapes;
```

- [ ] **Step 2: Build to confirm it compiles**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/server/toolSchemas.ts
git commit -m "feat(tools): consolidate all tool arg schemas in toolSchemas.ts"
```

---

## Task 3: Tool-meta resource files + consistency test

**Files:**
- Create: `resources/tool-meta/inspect.md`, `add.md`, `sync.md`, `config.md`, `onboard.md`, `ask.md`, `context.md`, `run.md`
- Test: `test/toolMeta.test.ts` (append consistency block)

Text is ported **verbatim** from the current code. YAML note: any `args` value
containing a colon-space (`: `) or embedded quotes MUST be quoted (done below).

- [ ] **Step 1: `resources/tool-meta/inspect.md`**

```markdown
---
title: Inspect containers/modules
args:
  container: Container name to inspect.
  module: Module path within the container.
---
List registered containers (no args), a container's modules + status (container), or a module's items (container + module).
```

- [ ] **Step 2: `resources/tool-meta/add.md`**

```markdown
---
title: Add a container or module
args:
  source: Git URL or local/OneDrive path (new container).
  name: Container name (defaults to the source basename) or module display name.
  sync: Git write mode for a new container.
  backend: Label a path source as local or onedrive.
  container: Target container (new module).
  path: Module folder path within the container (new module).
  type: "Module type: a built-in (knowledge, skills, tools, memory, project) or a custom type name (new module)."
  description: One-line module description (new module).
  config: Optional module config.
  create: Apply the change. Omit to preview a plan (no changes).
---
Add a container with { source, name?, sync?, backend? } (source is a git URL or a local/OneDrive path), or add a module with { container, path, type, config? }. By default add returns a plan and makes no changes; show it to the user, get confirmation, then re-call with create:true.
```

- [ ] **Step 3: `resources/tool-meta/sync.md`**

```markdown
---
title: Sync containers
args:
  container: "Container to sync (default: all)."
  message: Commit/PR message.
---
Validate and synchronize a container (or all containers). Git containers commit+push (auto) or open a PR (pr).
```

- [ ] **Step 4: `resources/tool-meta/config.md`**

```markdown
---
title: Config (view or change settings)
args:
  set: 'Config keys to set, e.g. { wakePhrase: "brain" }. Omit to list current config.'
---
View or change OKH configuration (stored in preferences.json). Call with no args to list current settings; pass { set: { <key>: <value> } } to change one or more. Known keys: {{var:configKeys}}.
```

- [ ] **Step 5: `resources/tool-meta/onboard.md`** (no args)

```markdown
---
title: Onboard (guided setup)
---
Return multi-turn onboarding guidance for a first-run user: intro and terminology (hub = the system; container = a repo/workspace/folder of modules), choosing a wake phrase, and setting up a first container with modules. Guidance only: this returns instructions, it does not perform setup itself. Set the wake phrase via the config tool.
```

- [ ] **Step 6: `resources/tool-meta/ask.md`**

```markdown
---
title: Ask (flow)
args:
  container: "Container name (default: all registered containers)."
  module: Module path within the container.
  question: The question to answer.
---
Return discipline that guides the agent to answer a question from your containers' modules. Guidance only: this returns instructions, it does not answer the question itself.
```

- [ ] **Step 7: `resources/tool-meta/context.md`**

```markdown
---
title: Context (flow)
args:
  container: "Container name (default: all registered containers)."
  task: The task to prepare for.
---
Return discipline that guides the agent to assemble a task-relevant working set across your containers. Guidance only: this returns instructions, it does not assemble the working set itself.
```

- [ ] **Step 8: `resources/tool-meta/run.md`**

```markdown
---
title: Run (module skill)
args:
  container: Container name. Provide with module to run a module skill; omit both to run a shared skill.
  module: Module path within the container. Provide with container; omit both to run a shared skill.
  skill: "Skill name to run: a module skill (with container+module) or a shared skill (see the referencing skill, e.g. grilling, okf-writer)."
  input: Freeform payload passed to the skill (e.g. the knowledge to learn, the observation to remember).
---
Return the discipline for a module's skill (resolved from the module's type + its own skills), with the target paths and your input injected. Guidance only: this returns instructions, it does not perform the work itself.
```

- [ ] **Step 9: Append the consistency test to `test/toolMeta.test.ts`**

Add these imports at the top of the file:
```ts
import { toolShapes, type ToolName } from "../src/server/toolSchemas.js";
import { loadToolMeta } from "../src/server/toolMeta.js";
import type { RenderContext } from "../src/prompts/templates.js";
```
(`loadToolMeta` may already be importable; keep a single import line combining `parseToolMeta`, `describeShape`, `loadToolMeta` from `../src/server/toolMeta.js`.)

Append this block:
```ts
describe("every tool has complete, consistent metadata", () => {
  const ctxFor = (name: ToolName): RenderContext | undefined =>
    name === "config" ? { vars: { configKeys: "wakePhrase" } } : undefined;

  for (const name of Object.keys(toolShapes) as ToolName[]) {
    it(`"${name}" resource loads and its args match its schema`, async () => {
      const m = await loadToolMeta(name, ctxFor(name));
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
      expect(() => describeShape(toolShapes[name], m.args)).not.toThrow();
    });
  }
});
```

- [ ] **Step 10: Run the consistency test**

Run: `npx vitest run test/toolMeta.test.ts`
Expected: PASS — all 8 tools load and every schema arg has a matching description. (If a YAML file is malformed, `parseFrontmatter` yields `data={}` → the missing-title check throws, so a broken file fails here loudly.)

- [ ] **Step 11: Commit**

```bash
git add resources/tool-meta test/toolMeta.test.ts
git commit -m "feat(tools): per-tool metadata resource files + all-tools consistency test"
```

---

## Task 4: Wire registration + delete `meta.ts`

**Files:**
- Modify: `src/server/tools.ts`, `src/server/index.ts`
- Delete: `src/prompts/meta.ts`

- [ ] **Step 1: Update imports in `src/server/tools.ts`**

Remove:
```ts
import { flowArgShapes, flowMeta } from "../prompts/meta.js";
```
Add (with the other imports; `buildAsk`/`buildContext`/`buildOnboard`/`buildRun`/`buildSharedRun` import stays):
```ts
import { loadToolMeta, describeShape } from "./toolMeta.js";
import { toolShapes, type ToolName } from "./toolSchemas.js";
import type { RenderContext } from "../prompts/templates.js";
```

- [ ] **Step 2: Add a module-level `toolReg` helper + make `registerTools` async**

Add this helper at module level (after the imports, before `registerTools`) — it's module-level so both `registerTools` and `registerFlowTools` can call it:
```ts
async function toolReg(name: ToolName, ctx?: RenderContext) {
  const m = await loadToolMeta(name, ctx);
  return { title: m.title, description: m.description, inputSchema: describeShape(toolShapes[name], m.args) };
}
```
Change the `registerTools` signature to async:
```ts
export async function registerTools(server: McpServer, service: ContainerService, paths: OkhPaths): Promise<void> {
```
At the end of `registerTools`, await the flow-tools call:
```ts
  await registerFlowTools(server, service);
```

- [ ] **Step 3: Replace each operational tool's metadata object**

For `inspect`, replace its registration options object
`{ title: "Inspect containers/modules", description: "…", annotations: { readOnlyHint: true }, inputSchema: { container: …, module: … } }`
with:
```ts
    { ...(await toolReg("inspect")), annotations: { readOnlyHint: true } },
```

For `add`, replace its options object (the `{ title: "Add a container or module", description: …, annotations: { openWorldHint: true }, inputSchema: { source: …, …, create: … } }`) with:
```ts
    { ...(await toolReg("add")), annotations: { openWorldHint: true } },
```

For `sync`, replace with:
```ts
    { ...(await toolReg("sync")), annotations: { openWorldHint: true } },
```

For `config`, replace with (note the render context supplying `configKeys`):
```ts
    { ...(await toolReg("config", { vars: { configKeys: configKeys.join(", ") } })), annotations: { readOnlyHint: false, openWorldHint: false } },
```

For `onboard`, replace its options object (currently uses `flowMeta.onboard.*` + `flowArgShapes.onboard`) with:
```ts
    { ...(await toolReg("onboard")), annotations: { readOnlyHint: true, openWorldHint: false } },
```

In every case, the inline `inputSchema` (and its Zod fields) is removed — the shape now comes from `toolShapes` via `toolReg`. Handlers are unchanged.

- [ ] **Step 4: Make `registerFlowTools` async and replace flow metadata objects**

Change the signature:
```ts
async function registerFlowTools(server: McpServer, service: ContainerService): Promise<void> {
```
Replace each flow tool's options object (each currently uses `flowMeta.*` + `flowArgShapes.*`), using the module-level `toolReg` from Step 2:
- `ask`: `{ ...(await toolReg("ask")), annotations: { readOnlyHint: true } },`
- `context`: `{ ...(await toolReg("context")), annotations: { readOnlyHint: true } },`
- `run`: `{ ...(await toolReg("run")), annotations: { readOnlyHint: true } },`

The inline `inputSchema: flowArgShapes.*` is removed from each; handlers are unchanged.

- [ ] **Step 5: Await `registerTools` in `src/server/index.ts`**

Change `registerTools(server, service, paths);` to:
```ts
  await registerTools(server, service, paths);
```
(`buildServer` is already `async`.)

- [ ] **Step 6: Delete `src/prompts/meta.ts`**

```bash
git rm src/prompts/meta.ts
```
Confirm nothing else imports it:
```bash
rg -n "prompts/meta|flowMeta|flowArgShapes|argDescriptions|FlowName|FlowMeta" src test
```
Expected: NO matches.

- [ ] **Step 7: Build, typecheck, and run the affected tests**

Run: `npm run build && npm run typecheck && npx vitest run test/server.test.ts test/toolMeta.test.ts`
Expected: clean build/typecheck; PASS. The server test still finds the 8 tool names.

- [ ] **Step 8: Add a couple of verbatim-port assertions to `test/server.test.ts`**

Inside `describe("MCP server surface", ...)`, add:
```ts
  it("tool titles/descriptions load from resources", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const add = tools.find((t) => t.name === "add")!;
    expect(add.description).toContain("returns a plan and makes no changes");
    const config = tools.find((t) => t.name === "config")!;
    expect(config.description).toContain("Known keys:");
    expect(config.description).not.toContain("{{"); // configKeys placeholder resolved
  });
```

- [ ] **Step 9: Run the server test**

Run: `npx vitest run test/server.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A src/server/tools.ts src/server/index.ts src/prompts/meta.ts test/server.test.ts
git commit -m "refactor(tools): register from tool-meta resources; delete meta.ts"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Build + typecheck + unit tests**

Run: `npm run build && npm run typecheck && npm test`
Expected: clean build, 0 type errors, all unit tests pass.

- [ ] **Step 2: Stale-reference sweep**

Run:
```bash
rg -n "prompts/meta|flowMeta|flowArgShapes|argDescriptions|FlowName|FlowMeta" src test
```
Expected: no matches.

- [ ] **Step 3: Eval subsystem checks**

Run: `npm run typecheck:eval && npm run test:eval && npm run eval:validate`
Expected: all green; "Configuration is valid."

- [ ] **Step 4: Full e2e eval (larger-change gate)**

Run: `npm run build && npm run eval`
Expected: scenarios pass (or only the known pre-existing soft-criterion flakes — `Learn - trivial fact`, and occasional agent-follow-through judgments). Tool descriptions are verbatim, so routing is unchanged; investigate any NEW failure that correlates with a changed tool description via `~/.promptfoo/promptfoo.db`.

- [ ] **Step 5: Final commit if fixups were needed**

```bash
git add -A
git commit -m "chore: post tool-metadata-resources fixups"
```

---

## Self-Review Notes (author)

- **Spec coverage:** §2 resources → Task 3; §3 loader/`describeShape` → Task 1; §4 schemas → Task 2; §5 registration → Task 4; §6 delete meta.ts → Task 4; §7 tests → Tasks 1,3,4 + Task 5.
- **Green-per-task ordering:** loader (additive, T1) → schemas (additive, T2) → resources + consistency test (T3) → wire + delete meta (T4, needs T1–T3) → verify (T5).
- **Type consistency:** `parseToolMeta`/`loadToolMeta`/`describeShape`/`ToolMeta`/`toolShapes`/`ToolName`/`toolReg` used identically across tasks; `registerTools`/`registerFlowTools` async; `RenderContext` reused from `templates.ts`.
- **`toolReg` scope:** module-level (Step 4 correction), so both `registerTools` and `registerFlowTools` can call it.
- **`as const` deliberately omitted** on `toolShapes` so each shape is assignable to `describeShape`'s `ZodRawShape` param; `keyof typeof toolShapes` still yields the 8-name union.
- **YAML quoting:** values with `: `/quotes (`add.type`, `sync.container`, `config.set`, `ask.container`, `context.container`, `run.skill`) are quoted; the consistency test catches any malformed file.
