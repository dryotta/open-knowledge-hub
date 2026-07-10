# OKH Prompt Templates + Tools-Only Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all MCP-emitted text into `resources/prompts/` templates rendered by a namespaced `{{namespace:path}}` engine, and stop exposing the flows as MCP prompts (tools-only).

**Architecture:** A logic-less template engine (`src/prompts/templates.ts`) resolves `config:` / `var:` / `prompt:` placeholders (pluggable resolver registry, strict fail-fast, include cycle + path-containment guards). Thin builders in `src/prompts/index.ts` compute a nested `vars` object + pass `config`, then call `renderTemplate`. The MCP prompt surface is deleted; `buildServer`/`buildRun`/`buildInstructions` become async.

**Tech Stack:** TypeScript (ESM, `import.meta.url` resource resolution), Vitest v4, MCP SDK, Zod.

**Spec:** `docs/superpowers/specs/2026-07-09-okh-prompt-templates-tools-only-design.md`

---

## File Structure

**Create:**
- `src/prompts/templates.ts` — the template engine (`resolvePath`, `renderString`, `renderTemplate`, `loadPromptFile`).
- `test/templates.test.ts` — engine unit tests.
- `resources/prompts/run.md`, `resources/prompts/shared-run.md`, `resources/prompts/instructions.md`, `resources/prompts/partials/write-policy.md` — new templates.

**Modify (merge envelope into existing discipline body):**
- `resources/prompts/ask.md`, `resources/prompts/context.md`, `resources/prompts/onboard.md`.

**Modify (code):**
- `src/prompts/index.ts` (builders → renderTemplate; `buildInstructions`; `buildRun` async).
- `src/server/index.ts` (`buildServer` async; instructions from template; drop `registerPrompts`).
- `src/server/tools.ts` (await `buildRun`; comment).
- `src/prompts/meta.ts` (comment).
- `src/index.ts` (`await buildServer()`).
- `test/prompts.test.ts`, `test/server.test.ts`.

**Delete:**
- `src/server/prompts.ts` (MCP prompt registration).
- `src/prompts/prompts.ts` (the old `loadPrompt` loader — superseded by `templates.ts`).

**Verification commands:** `npm run build`, `npm run typecheck`, `npm test` (targeted: `npx vitest run <file>`), `npm run typecheck:eval`, `npm run test:eval`, `npm run eval:validate`, full `npm run build && npm run eval`.

---

## Task 1: Template engine (`src/prompts/templates.ts`)

**Files:**
- Create: `src/prompts/templates.ts`
- Test: `test/templates.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/templates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderString, resolvePath } from "../src/prompts/templates.js";

const noLoad = async (): Promise<string> => { throw new Error("no includes"); };

describe("resolvePath", () => {
  it("resolves a nested slash-path to a string", () => {
    expect(resolvePath({ skill: { name: "learn" } }, "skill/name")).toBe("learn");
  });
  it("coerces a number leaf to a string", () => {
    expect(resolvePath({ n: 3 }, "n")).toBe("3");
  });
  it("throws on a missing key", () => {
    expect(() => resolvePath({ a: {} }, "a/b")).toThrow(/Unresolvable/);
  });
  it("throws when the leaf is not a string/number", () => {
    expect(() => resolvePath({ a: { b: {} } }, "a")).toThrow(/did not resolve/);
  });
});

describe("renderString", () => {
  it("substitutes var: and config: by slash-path", async () => {
    const out = await renderString(
      "{{var:q}} / {{config:wakePhrase}}",
      { vars: { q: "hi" }, config: { wakePhrase: "sam" } },
      noLoad,
    );
    expect(out).toBe("hi / sam");
  });
  it("resolves nested var paths", async () => {
    const out = await renderString("{{var:skill/name}}", { vars: { skill: { name: "learn" } } }, noLoad);
    expect(out).toBe("learn");
  });
  it("throws on an unknown namespace", async () => {
    await expect(renderString("{{bogus:x}}", {}, noLoad)).rejects.toThrow(/Unknown placeholder namespace/);
  });
  it("throws on a missing var (lockstep)", async () => {
    await expect(renderString("{{var:nope}}", { vars: {} }, noLoad)).rejects.toThrow(/Unresolvable/);
  });
  it("does not re-scan injected values", async () => {
    const out = await renderString("{{var:a}}", { vars: { a: "{{var:b}}" } }, noLoad);
    expect(out).toBe("{{var:b}}");
  });
  it("includes a partial via prompt: sharing the same context", async () => {
    const load = async (p: string): Promise<string> => {
      if (p === "partials/x.md") return "P:{{var:q}}";
      throw new Error("not found");
    };
    const out = await renderString("[{{prompt:partials/x.md}}]", { vars: { q: "hi" } }, load);
    expect(out).toBe("[P:hi]");
  });
  it("throws on an include cycle", async () => {
    const load = async (): Promise<string> => "{{prompt:a.md}}";
    await expect(renderString("{{prompt:a.md}}", {}, load)).rejects.toThrow(/cycle/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/templates.test.ts`
Expected: FAIL — `../src/prompts/templates.js` does not resolve.

- [ ] **Step 3: Implement `src/prompts/templates.ts`**

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { normalize, sep } from "node:path";

// resources/ sits at the package root; ../../ from src/prompts (tsx) and dist/prompts (built) both resolve there.
const PROMPTS_ROOT = new URL("../../resources/prompts/", import.meta.url);

export type TemplateName = "ask" | "context" | "onboard" | "run" | "shared-run" | "instructions";

export interface RenderContext {
  /** Caller-provided runtime values; `var:` resolves a slash-path into this. */
  vars?: Record<string, unknown>;
  /** Preferences object; `config:` resolves a slash-path into this. */
  config?: Record<string, unknown>;
}

/** Loads a raw template file (relative to resources/prompts/). */
export type LoadInclude = (relPath: string) => Promise<string>;

const TOKEN = /\{\{\s*([a-z]+):([^}]+?)\s*\}\}/g;

/** Resolve a slash-path (e.g. "skill/name") to a string leaf in obj, or throw. */
export function resolvePath(obj: unknown, path: string): string {
  let cur: unknown = obj;
  for (const seg of path.split("/")) {
    if (cur == null || typeof cur !== "object" || !(seg in (cur as Record<string, unknown>))) {
      throw new Error(`Unresolvable placeholder path "${path}"`);
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (typeof cur === "string" || typeof cur === "number") return String(cur);
  throw new Error(`Placeholder path "${path}" did not resolve to a string`);
}

function withinPrompts(abs: string): boolean {
  const root = normalize(fileURLToPath(PROMPTS_ROOT)).replace(/[\\/]+$/, "");
  const a = normalize(abs);
  return a === root || a.startsWith(root + sep);
}

const cache = new Map<string, string>();

/** Read + cache a template file under resources/prompts/, rejecting path escapes. */
export async function loadPromptFile(relPath: string): Promise<string> {
  const abs = fileURLToPath(new URL(relPath, PROMPTS_ROOT));
  if (!withinPrompts(abs)) throw new Error(`Template path escapes resources/prompts: "${relPath}"`);
  const cached = cache.get(abs);
  if (cached !== undefined) return cached;
  const text = await readFile(abs, "utf8");
  cache.set(abs, text);
  return text;
}

async function resolveToken(
  ns: string,
  arg: string,
  ctx: RenderContext,
  load: LoadInclude,
  seen: Set<string>,
): Promise<string> {
  switch (ns) {
    case "config":
      return resolvePath(ctx.config ?? {}, arg);
    case "var":
      return resolvePath(ctx.vars ?? {}, arg);
    case "prompt": {
      if (seen.has(arg)) throw new Error(`Template include cycle at "${arg}"`);
      const raw = await load(arg);
      return renderString(raw, ctx, load, new Set(seen).add(arg));
    }
    default:
      throw new Error(`Unknown placeholder namespace "${ns}"`);
  }
}

/** Render template text: resolve each {{ns:path}} token. Injected values are not re-scanned. */
export async function renderString(
  text: string,
  ctx: RenderContext = {},
  load: LoadInclude = loadPromptFile,
  seen: Set<string> = new Set(),
): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const [tok, ns, argRaw] = m;
    parts.push(text.slice(last, m.index));
    parts.push(await resolveToken(ns, argRaw.trim(), ctx, load, seen));
    last = (m.index ?? 0) + tok.length;
  }
  parts.push(text.slice(last));
  return parts.join("");
}

/** Load resources/prompts/<name>.md and render it against ctx. */
export async function renderTemplate(name: TemplateName, ctx: RenderContext = {}): Promise<string> {
  const file = `${name}.md`;
  return renderString(await loadPromptFile(file), ctx, loadPromptFile, new Set([file]));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/templates.test.ts && npm run build`
Expected: PASS + clean build. (Note: `renderTemplate` is not yet exercised — its real template files are created in Task 2.)

- [ ] **Step 5: Commit**

```bash
git add src/prompts/templates.ts test/templates.test.ts
git commit -m "feat(prompts): namespaced template engine (config/var/prompt resolvers)"
```

---

## Task 2: Template resource files

**Files:**
- Modify: `resources/prompts/ask.md`, `resources/prompts/context.md`, `resources/prompts/onboard.md`
- Create: `resources/prompts/run.md`, `resources/prompts/shared-run.md`, `resources/prompts/instructions.md`, `resources/prompts/partials/write-policy.md`

Each of `ask.md`/`context.md`/`onboard.md` currently holds only the inner discipline body. Transform each into a full template by **prepending the envelope** and **wrapping the existing body** in the `<discipline>` block. Do not alter the existing body text.

- [ ] **Step 1: `resources/prompts/ask.md`** — prepend before the existing `# OKF Ask` body, and append the closing tag at end of file:

Prepend (becomes the new top of the file):
```markdown
# OKH: ask

**Question:** {{var:question}}

**Scan these targets:**
{{var:targets}}

Answer using the `ask` discipline: fork a fresh sub-agent that reads only the
relevant module(s), starting from each module's overview (knowledge: index.md;
skills/tools: the listing; memory/project: recent files). Return a distilled,
**cited** answer. Do not load whole modules into this context.

<discipline name="ask">

```
Append at the very end of the file:
```markdown

</discipline>
```

- [ ] **Step 2: `resources/prompts/context.md`** — prepend before the existing body, append closing tag:

Prepend:
```markdown
# OKH: context

**Task:** {{var:task}}

**Available targets:**
{{var:targets}}

<discipline name="context">

```
Append at end:
```markdown

</discipline>
```

- [ ] **Step 3: `resources/prompts/onboard.md`** — prepend before the existing body, append closing tag:

Prepend:
```markdown
# OKH: onboard

**Wake phrase:** `{{config:wakePhrase}}`

**Current containers:**
{{var:targets}}

<discipline name="onboard">

```
Append at end:
```markdown

</discipline>
```

- [ ] **Step 4: Create `resources/prompts/run.md`**

```markdown
# OKH: run — {{var:skill/name}}

**Skill:** {{var:skill/name}} — {{var:skill/description}}
**Module:** {{var:module/type}} · {{var:module/name}} (`{{var:module/path}}`) → `{{var:module/absPath}}`
**Container:** {{var:container/name}} ({{var:container/backend}}, sync: {{var:container/sync}}) — `{{var:container/root}}`
**Input:** {{var:input}}

<discipline name="{{var:skill/name}}">

{{var:skill/body}}

</discipline>

{{prompt:partials/write-policy.md}}
```

- [ ] **Step 5: Create `resources/prompts/shared-run.md`**

```markdown
# OKH: run — {{var:skill/name}} (shared)

**Skill:** {{var:skill/name}} — {{var:skill/description}}
**Input:** {{var:input}}
{{var:resources}}
<discipline name="{{var:skill/name}}">

{{var:skill/body}}

</discipline>
```

- [ ] **Step 6: Create `resources/prompts/partials/write-policy.md`**

```markdown
## Write policy

After editing files:
1. Summarise the diff for the user and get explicit confirmation before persisting.
2. Call the `sync` tool ({ container }). It commits + pushes directly (sync: auto)
   or opens a pull request (sync: pr), per the container's configuration.
Never persist changes without the user's go-ahead. If several candidate
containers/modules are listed below, choose or confirm ONE target before writing.
```

- [ ] **Step 7: Create `resources/prompts/instructions.md`**

```markdown
Open Knowledge Hub: the hub is this system; it manages containers (a folder, OS-synced folder, or git repo) made of typed modules (knowledge, skills, tools, memory, project). Operational tools act directly: use inspect/add/sync to manage containers and config to view or change settings. The flows ask/context/run (and onboard) return discipline text (instructions) for you to follow — they do not read or write on their own; you do the reasoning and edits, then persist with sync. Start with the onboard flow for first-run setup. `add` previews changes and needs create:true to apply after user confirmation. You can address this hub as "{{config:wakePhrase}}": when a message begins with "{{config:wakePhrase}}" or mentions "the hub" / "knowledge hub", use these tools. Writes are synced via git (commit+push, or pull requests).
```

- [ ] **Step 8: Sanity-check rendering against real files**

Run this inline check (temporary):
```bash
node --import tsx -e "import('./src/prompts/templates.ts').then(async m => { const t = await m.renderTemplate('run', { vars: { skill: {name:'learn',description:'d',body:'B'}, module:{type:'knowledge',name:'KB',path:'kb',absPath:'/x/kb'}, container:{name:'hub',backend:'local',sync:'auto',root:'/x'}, input:'i' } }); console.log(t.includes('Write policy') && t.includes('learn') ? 'OK' : 'BAD'); })"
```
Expected: prints `OK` (the run template renders and includes the write-policy partial).

- [ ] **Step 9: Commit**

```bash
git add resources/prompts
git commit -m "feat(prompts): full prompt templates (flows, instructions, write-policy partial)"
```

---

## Task 3: Remove the MCP prompt surface

**Files:**
- Delete: `src/server/prompts.ts`
- Modify: `src/server/index.ts`, `src/prompts/meta.ts`, `src/server/tools.ts`, `test/server.test.ts`

- [ ] **Step 1: Update `test/server.test.ts` first (failing)**

Replace the "8 tools and 4 prompts" test body (currently asserting `listPrompts`) with:
```ts
  it("exposes exactly the 8 tools and no prompts", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["add", "ask", "config", "context", "inspect", "onboard", "run", "sync"]);
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
  });
```
Convert the "ask prompt returns discipline text" test (currently `getPrompt`) to a tool call:
```ts
  it("the ask tool returns discipline text pointing at resolved paths", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);
    await client.callTool({ name: "add", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add", arguments: { container: "hub", path: "kb", type: "knowledge", name: "KB", create: true } });
    const res = await client.callTool({ name: "ask", arguments: { container: "hub", question: "What is X?" } });
    const text = textOf(res);
    expect(text).toContain("What is X?");
    expect(text).toContain(join(dir, "kb"));
  });
```
Delete the "exposes the onboard prompt" test (lines that call `client.getPrompt({ name: "onboard" ... })`) and delete the now-unused `promptText` helper function.

> Note on the capability assertion: register no prompts and the MCP SDK should not advertise a `prompts` capability, so `getServerCapabilities()?.prompts` is `undefined`. Verify this empirically when you run the test. If the SDK still advertises the capability, assert instead that `(await client.listPrompts()).prompts` is an empty array (and, if `listPrompts` rejects with "Method not found", assert that rejection). Pick the one that matches actual behavior and keep it deterministic.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL — still registers prompts / `promptText` referenced or capability present.

- [ ] **Step 3: Delete `src/server/prompts.ts` and unwire it**

```bash
git rm src/server/prompts.ts
```
In `src/server/index.ts`, remove the import line `import { registerPrompts } from "./prompts.js";` and the call `registerPrompts(server, service, paths);`.

- [ ] **Step 4: Update comments**

In `src/prompts/meta.ts`, change the module doc comment that says each flow is "exposed BOTH as a prompt-tool (for clients without prompt support) and as an MCP prompt; both must present identical content" to:
```ts
/**
 * Single source of truth for the flows (`ask`, `context`, `onboard`, `run`).
 * Each flow is exposed as a tool. Flows never act on their own — they return
 * discipline/instructions for the client agent to follow. `run` resolves a
 * module skill (container+module) or, with neither, a module-less shared skill.
 */
```
In `src/server/tools.ts`, change the `registerFlowTools` doc comment (currently "The cognitive flows, exposed as tools for clients without prompt support. …") to:
```ts
/**
 * The cognitive flows, exposed as tools. Like all flows they return discipline
 * text (instructions) for the agent to follow — they do not read or write on
 * their own. `onboard` is another flow, registered above with the operational tools.
 */
```

- [ ] **Step 5: Build + test**

Run: `npm run build && npx vitest run test/server.test.ts`
Expected: PASS. (Builders in `index.ts` are unchanged here, so `callTool` output is identical to before.)

- [ ] **Step 6: Commit**

```bash
git add -A src/server/prompts.ts src/server/index.ts src/prompts/meta.ts src/server/tools.ts test/server.test.ts
git commit -m "refactor(server): drop MCP prompt surface; flows are tools-only"
```

---

## Task 4: Migrate flow builders to the template engine

**Files:**
- Modify: `src/prompts/index.ts`, `src/server/tools.ts`, `test/prompts.test.ts`
- Delete: `src/prompts/prompts.ts`

- [ ] **Step 1: Update `test/prompts.test.ts` (imports + async buildRun)**

(a) Remove the loader import on line 6 entirely: `import { loadPrompt } from "../src/prompts/prompts.js";`.

(b) Add `buildOnboard` to the builders import on line 7:
```ts
import { buildAsk, buildContext, buildOnboard, buildRun, buildSharedRun } from "../src/prompts/index.js";
```

(c) Delete the whole `describe("prompt loader", ...)` block (currently lines 17–35). To preserve the onboard-content coverage it provided (and to exercise the `config:` resolver end-to-end), add this test inside the existing `describe("prompt builders", ...)` block:
```ts
  it("onboard includes staged guidance, the wake phrase, and config routing", async () => {
    const text = await buildOnboard(targets, { wakePhrase: "sam" });
    expect(text).toContain("sam");
    expect(text).toMatch(/Stage 1/);
    expect(text).toContain("config { set: { wakePhrase");
    expect(text).not.toContain("onboard { wakePhrase");
  });
```

(d) The `buildRun` test (currently line 77, synchronous `const text = buildRun(...)`) must become async — `buildRun` now returns a Promise:
```ts
  it("buildRun embeds skill name, body, module path, and write policy", async () => {
    const target: ResolvedContainer = targets[0]!;
    const mod: ResolvedModule = target.modules[1]!;
    const skill: Skill = { name: "remember", description: "Record an observation", body: "Append-only timestamped entries.", source: "vendored" };
    const text = await buildRun(target, mod, skill, "Observed X");
    expect(text).toContain("remember");
    expect(text).toContain("Append-only timestamped entries.");
    expect(text).toContain("mem");
    expect(text).toContain("Write policy");
    expect(text).toContain("Observed X");
  });
```
Keep the existing `buildAsk`/`buildContext`/`buildSharedRun` tests unchanged (already async; still assert `How does auth work?`/target path/`<discipline name="ask">`/working-set/resource-paths — all produced by the templates).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/prompts.test.ts`
Expected: FAIL — import of `../src/prompts/prompts.js` gone / `buildRun` not yet async, etc.

- [ ] **Step 3: Rewrite `src/prompts/index.ts`**

Replace the entire file with:
```ts
import type { ResolvedContainer, ResolvedModule } from "../container/service.js";
import { skillResourcePaths } from "../modules/shared.js";
import type { Skill } from "../modules/skills.js";
import { renderTemplate } from "./templates.js";

const NONE = "(none provided — clarify with the user)";

/** Render the target containers -> modules -> absolute paths as a markdown list. */
function renderTargets(targets: ResolvedContainer[]): string {
  if (targets.length === 0) return "_No containers are registered. Use the `add` tool first._";
  return targets
    .map((c) => {
      const header = `- **${c.name}** (${c.backend}, sync: ${c.sync}) — \`${c.root}\``;
      const mods = c.modules.length
        ? c.modules.map((m) => `    - ${m.type}: \`${m.path}\` → \`${m.absPath}\``).join("\n")
        : "    - _(no modules)_";
      return `${header}\n${mods}`;
    })
    .join("\n");
}

/** Render a skill's resource paths block (empty when there are none). */
function renderResources(paths: string[]): string {
  if (paths.length === 0) return "";
  return `**Skill resources (open as needed):**\n${paths.map((p) => `- \`${p}\``).join("\n")}`;
}

export function buildInstructions(config: Record<string, unknown>): Promise<string> {
  return renderTemplate("instructions", { config });
}

export function buildAsk(targets: ResolvedContainer[], question?: string): Promise<string> {
  return renderTemplate("ask", { vars: { question: question ?? NONE, targets: renderTargets(targets) } });
}

export function buildContext(targets: ResolvedContainer[], task?: string): Promise<string> {
  return renderTemplate("context", { vars: { task: task ?? NONE, targets: renderTargets(targets) } });
}

export function buildOnboard(targets: ResolvedContainer[], config: Record<string, unknown>): Promise<string> {
  return renderTemplate("onboard", { config, vars: { targets: renderTargets(targets) } });
}

export function buildRun(
  target: ResolvedContainer,
  module: ResolvedModule,
  skill: Skill,
  input?: string,
): Promise<string> {
  return renderTemplate("run", {
    vars: {
      skill: { name: skill.name, description: skill.description, body: skill.body },
      module: { type: module.type, name: module.name, path: module.path, absPath: module.absPath },
      container: { name: target.name, backend: target.backend, sync: String(target.sync), root: target.root },
      input: input ?? NONE,
    },
  });
}

export async function buildSharedRun(skill: Skill, input?: string): Promise<string> {
  return renderTemplate("shared-run", {
    vars: {
      skill: { name: skill.name, description: skill.description, body: skill.body },
      input: input ?? NONE,
      resources: renderResources(await skillResourcePaths(skill)),
    },
  });
}
```

- [ ] **Step 4: Delete the old loader and update its last importer**

```bash
git rm src/prompts/prompts.ts
```
`src/prompts/index.ts` no longer imports it (done in Step 3). Confirm no other file imports `./prompts.js` from `src/prompts/` or `../src/prompts/prompts.js`:
Run: `rg -n "prompts/prompts|from \"./prompts.js\"" src test`
Expected: no matches (the only remaining `prompts.js` reference should be gone).

- [ ] **Step 5: Await `buildRun` in `src/server/tools.ts`**

In the `run` tool handler, the module-skill branch currently does `return ok(buildRun(target, mod, skill, args.input));`. Change to:
```ts
      return ok(await buildRun(target, mod, skill, args.input));
```
(`buildAsk`, `buildContext`, `buildOnboard`, `buildSharedRun` are already awaited.)

- [ ] **Step 6: Build + test**

Run: `npm run build && npx vitest run test/prompts.test.ts test/server.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src/prompts/index.ts src/prompts/prompts.ts src/server/tools.ts test/prompts.test.ts
git commit -m "refactor(prompts): render flows from templates; remove inline envelopes + old loader"
```

---

## Task 5: Server instructions from template (async `buildServer`)

**Files:**
- Modify: `src/server/index.ts`, `src/index.ts`, `test/server.test.ts`

- [ ] **Step 1: Update `test/server.test.ts` call sites + keep instructions assertion**

The two `buildServer({ service, paths })` call sites become `await buildServer({ service, paths })`. (Both are already inside `async` functions.) Leave the instructions test ("announces the configured wake phrase in server instructions", asserting the text contains `"brain"` and `"config"`) intact — the `instructions.md` template already contains both.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL — `buildServer` returns a `McpServer` but is about to become a `Promise`; without `await` the calls will now mismatch after Step 3. (If it still passes before Step 3, that is fine — proceed.)

- [ ] **Step 3: Make `buildServer` async and render instructions from the template**

In `src/server/index.ts`:
- Change the preferences import to load the full object: replace `import { loadPreferencesSync } from "../preferences.js";` usage so you have the whole preferences object.
- Remove the inline `buildInstructions` function entirely.
- Import the builder: `import { buildInstructions } from "../prompts/index.js";`

Replace the `buildServer` function with:
```ts
/** Construct the fully-wired MCP server. Dependencies are injectable for tests. */
export async function buildServer(options: BuildServerOptions = {}): Promise<McpServer> {
  const paths = options.paths ?? resolvePaths();
  const service = options.service ?? new ContainerService(paths);
  const prefs = loadPreferencesSync(paths);
  const server = new McpServer(
    { name: "open-knowledge-hub", version: "0.2.0" },
    { instructions: await buildInstructions(prefs as unknown as Record<string, unknown>) },
  );
  registerTools(server, service, paths);
  return server;
}
```
(The `import { loadPreferencesSync }` stays — `prefs` is the full preferences object, passed to `buildInstructions` which reads `config:wakePhrase` from it.)

- [ ] **Step 4: Await `buildServer` in `src/index.ts`**

Change `const server = buildServer();` to `const server = await buildServer();`.

- [ ] **Step 5: Build + test**

Run: `npm run build && npm run typecheck && npx vitest run test/server.test.ts`
Expected: PASS + clean build/typecheck. The instructions test still finds `"brain"` and `"config"`.

- [ ] **Step 6: Commit**

```bash
git add src/server/index.ts src/index.ts test/server.test.ts
git commit -m "refactor(server): render MCP instructions from template; buildServer is async"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Build + typecheck + unit tests**

Run: `npm run build && npm run typecheck && npm test`
Expected: clean build, 0 type errors, all unit tests pass.

- [ ] **Step 2: Stale-reference sweep**

Run:
```bash
rg -n "registerPrompts|getPrompt|listPrompts|loadPrompt\b|src/server/prompts|prompts/prompts|WRITE_POLICY|<discipline name=" src test
```
Expected: no matches in `src` for `registerPrompts`, `getPrompt`/`listPrompts`, `loadPrompt`, `prompts/prompts`, or `WRITE_POLICY`. The `<discipline name=` string should now appear only inside `resources/prompts/*.md`, not in `src`.

- [ ] **Step 3: Eval subsystem checks**

Run: `npm run typecheck:eval && npm run test:eval && npm run eval:validate`
Expected: all green; "Configuration is valid."

- [ ] **Step 4: Full e2e eval (larger-change gate)**

Run: `npm run build && npm run eval`
Expected: scenarios pass (or only the known pre-existing `Learn - trivial fact` routing flake). Investigate any NEW failure tied to templating via `~/.promptfoo/promptfoo.db` (latest `evals.id` → `eval_results` where `success=0`). In particular confirm `ask`/`context`/`run`/`onboard` tool outputs still render correctly end-to-end.

- [ ] **Step 5: Final commit if fixups were needed**

```bash
git add -A
git commit -m "chore: post-refactor fixups"
```

---

## Self-Review Notes (author)

- **Spec coverage:** §2 tools-only → Task 3; §3 engine → Task 1; §4 templates → Task 2; §5 builders + async server/instructions → Tasks 4–5; §6 cleanup → Tasks 3–5 (renames/comments/`WRITE_POLICY` removal) + Task 6 sweep; §7 tests → Tasks 1,3,4,5 + Task 6.
- **Type consistency:** `renderTemplate`/`renderString`/`resolvePath`/`loadPromptFile`/`RenderContext`/`TemplateName` used identically across tasks; `buildInstructions(config)`, `buildRun(...)→Promise`, `buildServer(...)→Promise<McpServer>` consistent.
- **Green-per-task ordering:** engine (additive, T1) → templates (additive, T2) → prompt-surface removal (T3, decouples `buildRun` callers so T4 can make it async) → builder migration + old-loader delete (T4) → instructions/async server (T5) → verify (T6).
- **`delete/` + package `files`** unchanged; no new dependency.
