# OKH — Prompt Templates + Tools-Only Surface

> **Historical note:** Standalone skill APIs in this record were later removed.
> Current `run` calls always target a concrete module.

**Status:** Approved design (pre-implementation)
**Date:** 2026-07-09
**Branch:** `feat/resources-restructure` (extends the resources restructure)
**Relates to:** `2026-07-09-okh-resources-restructure-design.md`

---

## 1. Summary

Two coupled changes to streamline how OKH emits text:

1. **Tools-only surface.** Stop exposing the flows as MCP *prompts*. Everything goes
   through the 8 tools. Delete `src/server/prompts.ts` and the `registerPrompts` call.
2. **Prompts as resource templates.** Move every string OKH emits — the flow
   envelopes AND the server instructions — out of code and into
   `resources/prompts/*.md` templates, rendered by a small logic-less template
   engine with a **namespaced `{{namespace:path}}` placeholder** grammar and a
   pluggable resolver registry (`config:` / `var:` / `prompt:`).

Also completes a code-path review: renames the awkward `src/prompts/prompts.ts`,
removes the duplicated `<discipline name>` wrapper, and makes `resources/prompts/`
the single home for all MCP-emitted text.

Core principles unchanged: no server-side LLM; deterministic; the client agent does
all reasoning.

### Goals

1. All MCP-emitted text (flow prompts + server instructions) is authored in
   `resources/prompts/` templates, editable without touching code.
2. Placeholders are namespaced and extensible: adding a data source = adding one
   resolver. Ships with `config:`, `var:`, `prompt:` (includes/partials).
3. Only tools are exposed; no MCP prompt capability.
4. No new runtime dependency; rendering is deterministic and strict (fails fast on
   template/code drift).

### Non-goals

- No template loops/conditionals in the template files (loops like the target list
  stay in code and are passed as pre-rendered `var:` strings).
- No change to tool behavior, arguments, or the operational tools.
- No change to `resources/module-types/` or `resources/shared/skills/`.

---

## 2. Tools-only surface

- **Delete** `src/server/prompts.ts` (the `registerPrompts` function and the four
  `server.registerPrompt(...)` calls).
- **`src/server/index.ts`**: remove the `registerPrompts` import and call.
- The MCP server no longer advertises a prompts capability. `ask`, `context`, `run`,
  `onboard` remain tools (unchanged registration in `tools.ts`).
- **`src/prompts/meta.ts`**: keep `flowMeta` / `flowArgShapes` / `argDescriptions`
  (still the source of tool titles/descriptions/input schemas). Update the module
  doc comment that says flows are "exposed BOTH as a prompt-tool ... and as an MCP
  prompt" to reflect tools-only.
- **`src/server/tools.ts`**: update the `registerFlowTools` doc comment ("exposed as
  tools for clients without prompt support") to just describe tools.

---

## 3. Template engine (`src/prompts/templates.ts`)

Renamed from `src/prompts/prompts.ts` (removes the `prompts/prompts` double-name).

### Placeholder grammar

`{{namespace:path}}` — namespace is lowercase letters; path is any run of
non-`}` characters (trimmed). No bare `{{x}}` form. Token regex:
`/\{\{\s*([a-z]+):([^}]+?)\s*\}\}/g`.

### Public API

```ts
export type TemplateName = "ask" | "context" | "onboard" | "run" | "shared-run" | "instructions";

export interface RenderContext {
  /** Caller-provided runtime values; `var:` resolves a slash-path into this. */
  vars?: Record<string, unknown>;
  /** Preferences object; `config:` resolves a slash-path into this. */
  config?: Record<string, unknown>;
}

/** Load resources/prompts/<name>.md and render it against ctx. */
export async function renderTemplate(name: TemplateName, ctx?: RenderContext): Promise<string>;
```

### Resolvers (registry keyed by namespace)

| Namespace | Arg | Behavior |
|---|---|---|
| `config:` | slash-path | `resolvePath(ctx.config, path)` → string; throw if missing/non-leaf |
| `var:` | slash-path | `resolvePath(ctx.vars, path)` → string; throw if missing/non-leaf |
| `prompt:` | file path under `resources/prompts/` | load the file and **recursively render** it against the same `ctx` (partials/includes) |

- `resolvePath(obj, "a/b/c")`: split on `/`, walk keys; the leaf must be a
  `string` or `number` (coerced via `String`); anything else (missing key, object,
  null) → throw `Missing/unresolvable path "a/b/c"`.
- `config:` and `var:` share `resolvePath`; they differ only in source object.
- Unknown namespace → throw `Unknown placeholder namespace "<ns>"`.

### `prompt:` include semantics

- Path resolves relative to `resources/prompts/`. **Containment check**: normalized
  absolute path must stay within `resources/prompts/` (reject `..` escapes) → throw.
- **Cycle guard**: a `seen: Set<string>` of absolute file paths is threaded through
  recursion; re-entering a file already in `seen` → throw `Template include cycle`.
- Included content is rendered with the same `ctx`, so a partial may use
  `{{var:…}}` / `{{config:…}}`.

### Rendering & strictness

- `renderString(text, ctx, seen)`: single pass over token matches; each token
  replaced by its resolver's result. **Injected values are not re-scanned**, so a
  resolved value (skill body, discipline text) containing `{{…}}` is safe.
- Any resolver error throws (fail-fast) — keeps templates and code in lockstep.
- `loadPromptFile(relPath)` reads + caches `resources/prompts/<relPath>` using the
  established `new URL("../../resources/prompts/…", import.meta.url)` pattern (works
  from `src` via tsx and `dist` when built). `renderTemplate(name)` =
  `renderString(loadPromptFile(`${name}.md`), ctx, { <abs of name.md> })`.

---

## 4. Template resources

### Layout
```
resources/prompts/
  instructions.md   ask.md   context.md   onboard.md   run.md   shared-run.md
  partials/
    write-policy.md
```

### Placeholder inventory (authoritative)

| Template | Placeholders |
|---|---|
| `instructions.md` | `{{config:wakePhrase}}` |
| `ask.md` | `{{var:question}}`, `{{var:targets}}` |
| `context.md` | `{{var:task}}`, `{{var:targets}}` |
| `onboard.md` | `{{config:wakePhrase}}`, `{{var:targets}}` |
| `run.md` | `{{var:skill/name}}`, `{{var:skill/description}}`, `{{var:skill/body}}`, `{{var:module/type}}`, `{{var:module/name}}`, `{{var:module/path}}`, `{{var:module/absPath}}`, `{{var:container/name}}`, `{{var:container/backend}}`, `{{var:container/sync}}`, `{{var:container/root}}`, `{{var:input}}`, `{{prompt:partials/write-policy.md}}` |
| `shared-run.md` | `{{var:skill/name}}`, `{{var:skill/description}}`, `{{var:skill/body}}`, `{{var:input}}`, `{{var:resources}}` |
| `partials/write-policy.md` | (static; no placeholders) |

Content is ported verbatim from today's code envelopes + `resources/prompts/{ask,
context,onboard}.md` discipline bodies, merged per flow, with the values swapped for
the placeholders above. The `<discipline name="…">` wrapper is written directly in
each template (for `run`/`shared-run` the name uses `{{var:skill/name}}`).

---

## 5. Code changes (`src/prompts/index.ts` + server wiring)

Builders become thin: compute the nested `vars` object (and pass `config`), then
call `renderTemplate`. `renderTargets` and a `renderResources` helper and the
`"(none provided — clarify with the user)"` default stay in code (the only
presentation logic left).

```ts
const NONE = "(none provided — clarify with the user)";

export function buildInstructions(config: Record<string, unknown>): Promise<string> {
  return renderTemplate("instructions", { config });
}

export async function buildAsk(targets: ResolvedContainer[], question?: string): Promise<string> {
  return renderTemplate("ask", { vars: { question: question ?? NONE, targets: renderTargets(targets) } });
}

export async function buildContext(targets: ResolvedContainer[], task?: string): Promise<string> {
  return renderTemplate("context", { vars: { task: task ?? NONE, targets: renderTargets(targets) } });
}

export async function buildOnboard(targets: ResolvedContainer[], config: Record<string, unknown>): Promise<string> {
  return renderTemplate("onboard", { config, vars: { targets: renderTargets(targets) } });
}

export async function buildRun(target: ResolvedContainer, module: ResolvedModule, skill: Skill, input?: string): Promise<string> {
  return renderTemplate("run", { vars: {
    skill: { name: skill.name, description: skill.description, body: skill.body },
    module: { type: module.type, name: module.name, path: module.path, absPath: module.absPath },
    container: { name: target.name, backend: target.backend, sync: String(target.sync), root: target.root },
    input: input ?? NONE,
  } });
}

export async function buildSharedRun(skill: Skill, input?: string): Promise<string> {
  return renderTemplate("shared-run", { vars: {
    skill: { name: skill.name, description: skill.description, body: skill.body },
    input: input ?? NONE,
    resources: renderResources(await skillResourcePaths(skill)),
  } });
}
```

- `buildRun` becomes **async** (was sync). Update its two call sites in
  `tools.ts` and — after the delete — none in `prompts.ts`. `tools.ts` already
  `await`s the other builders, so `return ok(await buildRun(...))`.
- `renderResources(paths: string[])`: returns `""` when empty, else the
  `**Skill resources (open as needed):**\n- \`p\`…` block (today's `resourceBlock`).
- Remove the `WRITE_POLICY` const (now `partials/write-policy.md`).

### Server instructions from template

- `src/server/index.ts`: `buildServer` becomes **async**. Load full preferences
  (not just `wakePhrase`), `await buildInstructions(prefs)`, pass to `new McpServer`.
- `buildInstructions` moves to `src/prompts/index.ts` (renders `instructions.md`).
  The old inline string in `server/index.ts` is deleted.
- Ripple (small): `src/index.ts` → `const server = await buildServer();`;
  `test/server.test.ts` two call sites → `await buildServer(...)`.
- The `instructions.md` template MUST still contain the wake phrase and the word
  `config` (an existing test asserts both).

---

## 6. Code-path / naming cleanup (review outcome)

- `src/prompts/prompts.ts` → `src/prompts/templates.ts`.
- `<discipline name>` wrapper duplicated across 5 builders → lives once per template.
- `buildInstructions` string removed from `server/index.ts`; all MCP text now from
  `resources/prompts/`.
- Dual-surface comments in `meta.ts` and `tools.ts` updated to tools-only.
- `resources/prompts/` is the single, consistent home for MCP-emitted text; the only
  code-side presentation logic is `renderTargets` + `renderResources` + the `NONE`
  default in `src/prompts/index.ts`.

---

## 7. Tests

**Unit (`npm test`, `npm run typecheck`):**
- New `test/templates.test.ts`: `renderTemplate`/`renderString` behavior —
  `config:`/`var:` slash-path resolution; missing path throws; unknown namespace
  throws; `prompt:` include renders a partial with shared ctx; include cycle throws;
  `..` containment throws; injected value containing `{{…}}` is not re-scanned.
- `test/prompts.test.ts`: replace the `loadPrompt` loader tests with the above (or
  keep loader-level checks minimal); keep the `buildAsk`/`buildContext`/`buildRun`
  output assertions (rendered output is unchanged: question, target path,
  `<discipline name="ask">`, write policy, etc.). `buildRun` is now async → `await`.
- `test/server.test.ts`:
  - Change "exposes exactly the 8 tools and 4 prompts" → assert 8 tools and **no**
    prompts (server advertises no prompts capability; assert `listPrompts` returns
    empty or the capability is absent — whichever the SDK yields with zero prompts).
  - Convert the "ask prompt returns discipline text" test (currently `getPrompt`) to
    `callTool({ name: "ask", … })` asserting the same text; **remove** the "exposes
    the onboard prompt" test (covered by the existing `callTool` onboard test) and
    the `promptText` helper.
  - `await buildServer(...)` at both call sites.
  - Keep the instructions test (wake phrase + `config`).

**Eval:** unaffected — the eval harness drives Copilot CLI **tools**, never MCP
prompts (verified: no `getPrompt`/`listPrompts`/`registerPrompt` usage in `eval/`).
Run `typecheck:eval` / `test:eval` / `eval:validate` and the full `npm run eval` as
the larger-change completion gate.

---

## 8. Risks & mitigations

- **Async `buildServer` ripple** → only 3 call sites; `main()` already async.
- **Rendered-output drift from porting envelopes to templates** → builder output
  tests assert the same substrings as today; port text verbatim.
- **Strict resolver throwing at runtime** → covered by unit tests for each template's
  var set; a missing placeholder fails fast in tests, not in production.
- **`prompt:` path traversal** → containment check + cycle guard, unit-tested.
- **Client that only supported prompts** → OKH already exposed identical tools; the
  design intent is tools-only.

---

## 9. Out of scope / deferred

- Template conditionals/loops (kept in code as pre-rendered `var:` strings).
- Additional resolver namespaces (`env:`, `date:`, …) — trivial to add later.
- Any change to operational tools, module types, or module-scoped skills.
