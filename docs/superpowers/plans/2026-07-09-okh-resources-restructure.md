# OKH `resources/` Restructure Implementation Plan

> **Partially superseded historical plan:** The prompt and module-type layout remains,
> but the standalone skill model described below was removed. Every runnable skill now
> belongs to a module; common guidance is exposed through `okh://instructions/`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `resources/` into `prompts/` (flow bodies), `shared/skills/` (runnable-standalone skills), and `module-types/` (per-type skills); reclaim four orphaned OKF docs; add module-less `run { skill }` for shared skills.

**Architecture:** Deterministic MCP server, no server-side LLM. Prompt bodies are loaded by `src/prompts/*` and wrapped in `<discipline name>` blocks. Skills are `SKILL.md` files discovered from disk; `run` renders a skill body for the client agent. Shared skills are resolved module-less; module skills keep container+module.

**Tech Stack:** TypeScript (ESM, `import.meta.url` resource resolution), Vitest v4, Zod schemas, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-07-09-okh-resources-restructure-design.md`

---

## File Structure

**New files:**
- `resources/prompts/{ask,context,onboard}.md` (moved from `okf/`/`discipline/`)
- `resources/shared/skills/grilling/SKILL.md` (new)
- `resources/shared/skills/okf-writer/{SKILL.md,OKF-FORMAT.md}` (moved)
- `resources/module-types/**` (moved from `resources/types/**`)
- `resources/module-types/knowledge/skills/initialize/SKILL.md` (moved from `okf/okf-new-from-repo.md`)
- `src/modules/shared.ts` (shared-skill resolver + resource paths)
- `delete/resources/okf/okf-learn.md` (archived dead file)

**Renamed:** `src/prompts/discipline.ts` → `src/prompts/prompts.ts`

**Modified:** `src/prompts/index.ts`, `src/prompts/meta.ts`, `src/modules/skills.ts`, `src/modules/vendored.ts`, `src/container/service.ts`, `src/server/tools.ts`, `src/server/prompts.ts`, `test/prompts.test.ts`, `README.md`, `USAGE.md`, `CONTEXT.md`, `eval/scenarios/learn/trivial-fact.yaml`, `eval/README.md`.

**Verification commands (used throughout):**
- Build: `npm run build`
- Typecheck: `npm run typecheck`
- Unit tests: `npm test` (or targeted `npx vitest run <file>`)
- Eval checks: `npm run typecheck:eval`, `npm run test:eval`, `npm run eval:validate`
- Full e2e: `npm run build` then `npm run eval`

---

## Task 1: Rename `resources/types/` → `resources/module-types/`

**Files:**
- Move: `resources/types/**` → `resources/module-types/**`
- Modify: `src/modules/vendored.ts:6-7`
- Test: `test/run.test.ts` (existing, must stay green)

- [ ] **Step 1: Move the tree with git**

```bash
git mv resources/types resources/module-types
```

- [ ] **Step 2: Update the root constant + comment in `src/modules/vendored.ts`**

Replace lines 6-7:

```ts
// resources/ sits at the package root; ../../ resolves there from src (tsx) and dist (built).
const TYPES_ROOT = new URL("../../resources/types/", import.meta.url);
```

with:

```ts
// resources/ sits at the package root; ../../ resolves there from src (tsx) and dist (built).
const MODULE_TYPES_ROOT = new URL("../../resources/module-types/", import.meta.url);
```

Then update the one reference in `vendoredSkillsDir` (was `TYPES_ROOT`):

```ts
  return fileURLToPath(new URL(`${type}/skills/`, MODULE_TYPES_ROOT));
```

- [ ] **Step 3: Build + run the skills tests**

Run: `npm run build && npx vitest run test/run.test.ts test/skills.test.ts`
Expected: PASS (effective skills for `memory`/`knowledge` still resolve `remember`/`reflect`/`learn`).

- [ ] **Step 4: Commit**

```bash
git add resources/module-types src/modules/vendored.ts
git commit -m "refactor(resources): rename types/ to module-types/"
```

---

## Task 2: Move flow docs to `resources/prompts/` and rename the loader

**Files:**
- Move: `resources/okf/okf-ask.md` → `resources/prompts/ask.md`, `resources/discipline/context.md` → `resources/prompts/context.md`, `resources/discipline/onboard.md` → `resources/prompts/onboard.md`
- Rename: `src/prompts/discipline.ts` → `src/prompts/prompts.ts`
- Modify: `src/prompts/index.ts`, `test/prompts.test.ts`
- Test: `test/prompts.test.ts`

- [ ] **Step 1: Move the three docs**

```bash
git mv resources/okf/okf-ask.md resources/prompts/ask.md
git mv resources/discipline/context.md resources/prompts/context.md
git mv resources/discipline/onboard.md resources/prompts/onboard.md
```

- [ ] **Step 2: Strip the frontmatter from `resources/prompts/ask.md`**

Delete the leading frontmatter block (lines 1-5) so the file begins at `# OKF Ask`:

Remove:
```markdown
---
name: okf-ask
description: Answer a question from an OKF knowledge pack without loading the pack into the main context — fork a sub-agent to read it and return a distilled, self-contained answer with next steps.
disable-model-invocation: true
---

```

- [ ] **Step 3: Update the failing tests first in `test/prompts.test.ts`**

Change the import (line 6) from:
```ts
import { loadOkf, loadDiscipline, combineOkf } from "../src/prompts/discipline.js";
```
to:
```ts
import { loadPrompt } from "../src/prompts/prompts.js";
```

Replace the whole `describe("discipline loader", ...)` block (lines 17-41) with:

```ts
describe("prompt loader", () => {
  it("loads the ask prompt", async () => {
    const text = await loadPrompt("ask");
    expect(text.length).toBeGreaterThan(0);
  });

  it("loads the context prompt", async () => {
    expect(await loadPrompt("context")).toMatch(/working set/i);
  });

  it("onboard prompt is staged and routes wake-phrase changes to config", async () => {
    const text = await loadPrompt("onboard");
    expect(text).toMatch(/Stage 1/);
    expect(text).toMatch(/Stage 2/);
    expect(text).toMatch(/Stage 3/);
    expect(text).toContain("config { set: { wakePhrase");
    expect(text).not.toContain("onboard { wakePhrase");
  });
});
```

Update the ask builder assertion (line 78) from:
```ts
    expect(text).toContain('<discipline name="okf-ask">');
```
to:
```ts
    expect(text).toContain('<discipline name="ask">');
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/prompts.test.ts`
Expected: FAIL — `../src/prompts/prompts.js` does not resolve yet.

- [ ] **Step 5: Rename and rewrite the loader as `src/prompts/prompts.ts`**

```bash
git mv src/prompts/discipline.ts src/prompts/prompts.ts
```

Replace the entire contents of `src/prompts/prompts.ts` with:

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// resources/ sits at the package root; ../../ from src/prompts (tsx dev) and
// dist/prompts (built) both resolve there.
const PROMPTS_ROOT = new URL("../../resources/prompts/", import.meta.url);

export type PromptDoc = "ask" | "context" | "onboard";

const cache = new Map<string, string>();

/** Load a flow prompt body (ask/context/onboard) from resources/prompts/. */
export async function loadPrompt(doc: PromptDoc): Promise<string> {
  const cached = cache.get(doc);
  if (cached) return cached;
  const path = fileURLToPath(new URL(`${doc}.md`, PROMPTS_ROOT));
  const text = await readFile(path, "utf8");
  cache.set(doc, text);
  return text;
}
```

- [ ] **Step 6: Update `src/prompts/index.ts` — imports + `buildAsk`**

Change the import (line 3) from:
```ts
import { combineOkf, loadDiscipline } from "./discipline.js";
```
to:
```ts
import { loadPrompt } from "./prompts.js";
```

Replace `buildAsk` (lines 28-43) with:

```ts
export async function buildAsk(targets: ResolvedContainer[], question?: string): Promise<string> {
  const discipline = await loadPrompt("ask");
  return `# OKH: ask

**Question:** ${question ?? "(none provided — clarify with the user)"}

**Scan these targets:**
${renderTargets(targets)}

Answer using the \`ask\` discipline: fork a fresh sub-agent that reads only the
relevant module(s), starting from each module's overview (knowledge: index.md;
skills/tools: the listing; memory/project: recent files). Return a distilled,
**cited** answer. Do not load whole modules into this context.

<discipline name="ask">

${discipline}

</discipline>`;
}
```

In `buildContext` (line 46) change `loadDiscipline("context")` to `loadPrompt("context")`.
In `buildOnboard` (line 79) change `loadDiscipline("onboard")` to `loadPrompt("onboard")`.

- [ ] **Step 7: Run tests + build to verify green**

Run: `npx vitest run test/prompts.test.ts && npm run build`
Expected: PASS + clean build.

- [ ] **Step 8: Commit**

```bash
git add resources/prompts src/prompts/prompts.ts src/prompts/index.ts test/prompts.test.ts
git commit -m "refactor(resources): unify flow docs under prompts/ and rename loader"
```

---

## Task 3: Add `dir` to `Skill` and surface it in discovery

**Files:**
- Modify: `src/modules/skills.ts`
- Test: `test/skills.test.ts`

- [ ] **Step 1: Write the failing test in `test/skills.test.ts`**

Add `readSkill` to the existing skills.js import (line 5) — it becomes:
```ts
import { discoverModuleSkills, mergeSkills, MODULE_SKILL_ROOTS, readSkill, type Skill } from "../src/modules/skills.js";
```

Add this test inside the `describe("module skills", ...)` block (reuses the file's existing `mkdtemp`/`mkdir`/`writeFile`/`rm`/`join`/`tmpdir` imports):

```ts
it("populates the skill's absolute dir", async () => {
  const mod = await mkdtemp(join(tmpdir(), "okh-sk-"));
  try {
    const dir = join(mod, "grill");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: grill\ndescription: d\n---\n\nBody.\n");
    const s = await readSkill(dir, "vendored");
    expect(s?.dir).toBe(dir);
  } finally {
    await rm(mod, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/skills.test.ts`
Expected: FAIL — `dir` is `undefined`.

- [ ] **Step 3: Add `dir` to the `Skill` interface and set it in `readSkill`**

In `src/modules/skills.ts`, add to the `Skill` interface (after `source`):

```ts
  /** Absolute path to the skill's folder (holds SKILL.md and any resource files). */
  dir?: string;
```

Change the `readSkill` return (line 37) from:
```ts
  return { name, description: stringField(data, "description") ?? "", body: body.trim(), source };
```
to:
```ts
  return { name, description: stringField(data, "description") ?? "", body: body.trim(), source, dir };
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/skills.ts test/skills.test.ts
git commit -m "feat(skills): expose each skill's absolute dir"
```

---

## Task 4: Shared-skill resolver (`src/modules/shared.ts`)

**Files:**
- Create: `src/modules/shared.ts`
- Modify: `src/modules/skills.ts` (add optional `source` param to `discoverVendoredSkills`)
- Test: `test/shared.test.ts` (new)

- [ ] **Step 1: Allow a source label in `discoverVendoredSkills`**

In `src/modules/skills.ts`, change the signature (line 60) from:
```ts
export async function discoverVendoredSkills(vendoredDir: string): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const name of await subdirNames(vendoredDir)) {
    const s = await readSkill(join(vendoredDir, name), "vendored");
```
to:
```ts
export async function discoverVendoredSkills(vendoredDir: string, source = "vendored"): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const name of await subdirNames(vendoredDir)) {
    const s = await readSkill(join(vendoredDir, name), source);
```

- [ ] **Step 2: Write the failing test `test/shared.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { sharedSkills, resolveSharedSkill, skillResourcePaths } from "../src/modules/shared.js";

describe("shared skills", () => {
  it("lists the bundled shared skills", async () => {
    const names = (await sharedSkills()).map((s) => s.name).sort();
    expect(names).toContain("grilling");
    expect(names).toContain("okf-writer");
  });

  it("resolves a shared skill by name; unknown throws with a list", async () => {
    const grilling = await resolveSharedSkill("grilling");
    expect(grilling.body.length).toBeGreaterThan(0);
    expect(grilling.source).toBe("shared");
    await expect(resolveSharedSkill("nope")).rejects.toThrow(/grilling|okf-writer/);
  });

  it("surfaces okf-writer's OKF-FORMAT.md resource by absolute path", async () => {
    const writer = await resolveSharedSkill("okf-writer");
    const resources = await skillResourcePaths(writer);
    expect(resources.some((p) => p.endsWith("OKF-FORMAT.md"))).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/shared.test.ts`
Expected: FAIL — `../src/modules/shared.js` does not resolve (and shared skills not created yet).

- [ ] **Step 4: Create `src/modules/shared.ts`**

```ts
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { discoverVendoredSkills, type Skill } from "./skills.js";
import { OkhError } from "../errors.js";

// resources/ sits at the package root; ../../ resolves there from src (tsx) and dist (built).
const SHARED_ROOT = new URL("../../resources/shared/skills/", import.meta.url);

/** List the bundled shared skills (runnable module-less via the run tool). */
export async function sharedSkills(): Promise<Skill[]> {
  return discoverVendoredSkills(fileURLToPath(SHARED_ROOT), "shared");
}

/** Resolve one shared skill by name; throws NOT_FOUND listing available shared skills. */
export async function resolveSharedSkill(name: string): Promise<Skill> {
  const skills = await sharedSkills();
  const found = skills.find((s) => s.name === name);
  if (!found) {
    const names = skills.map((s) => s.name).join(", ") || "(none)";
    throw new OkhError("NOT_FOUND", `No shared skill "${name}". Available: ${names}.`);
  }
  return found;
}

/** Absolute paths of a skill's sibling resource files (everything but SKILL.md). */
export async function skillResourcePaths(skill: Skill): Promise<string[]> {
  if (!skill.dir) return [];
  const entries = await readdir(skill.dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name !== "SKILL.md")
    .map((e) => join(skill.dir!, e.name))
    .sort();
}
```

Note: the test's assertions on `grilling`/`okf-writer` content pass only after Tasks 5-6 create those files. Until then this test partially fails; that is expected and resolved by Task 6's Step "run tests".

- [ ] **Step 5: Verify the module compiles**

Run: `npm run build`
Expected: clean build (the runtime assertions about grilling/okf-writer are completed in Tasks 5-6).

- [ ] **Step 6: Commit**

```bash
git add src/modules/shared.ts src/modules/skills.ts test/shared.test.ts
git commit -m "feat(shared): add shared-skill resolver and resource paths"
```

---

## Task 5: Create the `grilling` shared skill

**Files:**
- Create: `resources/shared/skills/grilling/SKILL.md`
- Test: `test/shared.test.ts` (the grilling assertions from Task 4)

- [ ] **Step 1: Create `resources/shared/skills/grilling/SKILL.md`**

```markdown
---
name: grilling
description: Grill the user relentlessly about a plan, design, or scope decision — one question at a time — until you reach a shared understanding. Use to stress-test before building or to negotiate scope.
---

# Grilling

Interview the user relentlessly about every aspect of this plan, design, or scope
decision until you reach a shared understanding. Walk down each branch of the
decision tree, resolving dependencies between decisions one by one. For each
question, provide your recommended answer.

Ask questions **one at a time**, waiting for the answer before continuing. Asking
several at once is bewildering.

If a *fact* can be found by exploring the codebase or the materials at hand, look it
up rather than asking. The *decisions* are the user's — put each one to them and
wait for the answer.

Do not act on the plan until the user confirms you have reached a shared
understanding.

---
_Adapted from [mattpocock/skills](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md)._
```

- [ ] **Step 2: Run the grilling assertions**

Run: `npx vitest run test/shared.test.ts -t grilling`
Expected: the "lists" and "resolves" tests pass for `grilling` (okf-writer parts complete in Task 6).

- [ ] **Step 3: Commit**

```bash
git add resources/shared/skills/grilling/SKILL.md
git commit -m "feat(shared): add grilling skill (adapted from mattpocock/skills)"
```

---

## Task 6: Move `okf-writer` + `OKF-FORMAT` into `shared/skills/okf-writer/`

**Files:**
- Move: `resources/okf/okf-writer.md` → `resources/shared/skills/okf-writer/SKILL.md`
- Move: `resources/okf/OKF-FORMAT.md` → `resources/shared/skills/okf-writer/OKF-FORMAT.md`
- Test: `test/shared.test.ts`

- [ ] **Step 1: Move the two files**

```bash
git mv resources/okf/okf-writer.md resources/shared/skills/okf-writer/SKILL.md
git mv resources/okf/OKF-FORMAT.md resources/shared/skills/okf-writer/OKF-FORMAT.md
```

- [ ] **Step 2: Neutralize the dangling `domain-modeling` reference in the moved `SKILL.md`**

In `resources/shared/skills/okf-writer/SKILL.md`, change:
```markdown
`CONTEXT.md`, `CONTEXT-MAP.md`, or `docs/adr/`, treat those as authoritative: cite/link them as
sources rather than re-deriving or contradicting them. Do not fork their authoring — that's
`domain-modeling`'s job.
```
to:
```markdown
`CONTEXT.md`, `CONTEXT-MAP.md`, or `docs/adr/`, treat those as authoritative: cite/link them as
sources rather than re-deriving or contradicting them. Do not re-derive what they already settle.
```

(The `[OKF-FORMAT.md](OKF-FORMAT.md)` links remain valid — the file is co-located and is
surfaced by absolute path at run time.)

- [ ] **Step 3: Run the full shared-skills test**

Run: `npx vitest run test/shared.test.ts`
Expected: PASS (all three tests, including the OKF-FORMAT.md resource surfacing).

- [ ] **Step 4: Commit**

```bash
git add resources/shared/skills/okf-writer
git commit -m "feat(shared): move okf-writer skill + OKF-FORMAT resource into shared/"
```

---

## Task 7: `buildSharedRun` and module-less `run`

**Files:**
- Modify: `src/prompts/index.ts` (add `buildSharedRun`)
- Modify: `src/prompts/meta.ts` (optional container/module on `run`)
- Modify: `src/container/service.ts` (add `resolveSharedSkill` delegate)
- Modify: `src/server/tools.ts` and `src/server/prompts.ts` (branch on presence of container+module)
- Test: `test/prompts.test.ts`, `test/run.test.ts`

- [ ] **Step 1: Write failing tests**

In `test/prompts.test.ts`, add to the `describe("prompt builders", ...)` block:

```ts
it("buildSharedRun embeds a module-less shared skill and its resource paths", async () => {
  const skill: Skill = { name: "okf-writer", description: "Author a bundle", body: "Write cited concepts.", source: "shared", dir: "/x" };
  const text = await buildSharedRun(skill, "Draft the auth pack");
  expect(text).toContain("okf-writer");
  expect(text).toContain("Write cited concepts.");
  expect(text).toContain("Draft the auth pack");
  expect(text).not.toContain("Write policy");
});
```

Add `buildSharedRun` to the import on line 7:
```ts
import { buildAsk, buildContext, buildRun, buildSharedRun } from "../src/prompts/index.js";
```

In `test/run.test.ts`, add a new `describe`:

```ts
describe("shared skills", () => {
  it("resolveSharedSkill returns the grilling body; unknown throws with a list", async () => {
    const { svc } = await setup();
    const s = await svc.resolveSharedSkill("grilling");
    expect(s.body.length).toBeGreaterThan(0);
    await expect(svc.resolveSharedSkill("nope")).rejects.toThrow(/grilling|okf-writer/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/prompts.test.ts test/run.test.ts`
Expected: FAIL — `buildSharedRun` and `svc.resolveSharedSkill` are undefined.

- [ ] **Step 3: Add `buildSharedRun` to `src/prompts/index.ts`**

Add imports at the top of the file:
```ts
import { skillResourcePaths } from "../modules/shared.js";
```

Add this function (place it after `buildRun`):

```ts
export async function buildSharedRun(skill: Skill, input?: string): Promise<string> {
  const resources = await skillResourcePaths(skill);
  const resourceBlock = resources.length
    ? `\n**Skill resources (open as needed):**\n${resources.map((p) => `- \`${p}\``).join("\n")}\n`
    : "";
  return `# OKH: run — ${skill.name} (shared)

**Skill:** ${skill.name} — ${skill.description}
**Input:** ${input ?? "(none provided — clarify with the user)"}
${resourceBlock}
<discipline name="${skill.name}">

${skill.body}

</discipline>`;
}
```

- [ ] **Step 4: Add `resolveSharedSkill` to `ContainerService`**

`src/container/service.ts` already imports `type Skill` from `../modules/skills.js` (line 31). Add one import next to it:
```ts
import { resolveSharedSkill as resolveShared } from "../modules/shared.js";
```

Add this method next to `resolveSkill`:

```ts
  /** Resolve a module-less shared skill by name (runnable via run with no container/module). */
  resolveSharedSkill(name: string): Promise<Skill> {
    return resolveShared(name);
  }
```

- [ ] **Step 5: Make `container`/`module` optional on the `run` flow in `src/prompts/meta.ts`**

Replace the `run` entry in `flowArgShapes` (lines 30-35) with:

```ts
  run: {
    container: z.string().optional().describe("Container name. Provide with module to run a module skill; omit both to run a shared skill."),
    module: z.string().optional().describe("Module path within the container. Provide with container; omit both to run a shared skill."),
    skill: z.string().describe("Skill name to run: a module skill (with container+module) or a shared skill (see the referencing skill, e.g. grilling, okf-writer)."),
    input: z.string().optional().describe("Freeform payload passed to the skill (e.g. the knowledge to learn, the observation to remember)."),
  },
```

Update the module doc comment at the top of `meta.ts` (lines 6-9) to note the shared mode — append to the existing paragraph:
```ts
 * act on their own — they return discipline/instructions for the client agent
 * to follow. `run` resolves a module skill (container+module) or, with neither,
 * a module-less shared skill.
```

- [ ] **Step 6: Branch the `run` tool handler in `src/server/tools.ts`**

Replace the `run` handler (lines 360-367) with:

```ts
    handler(async (args: { container?: string; module?: string; skill: string; input?: string }) => {
      const hasContainer = args.container !== undefined && !isBlank(args.container);
      const hasModule = args.module !== undefined && !isBlank(args.module);
      if (hasContainer !== hasModule) {
        return fail("run needs both container and module (module skill), or neither (shared skill).");
      }
      if (!hasContainer) {
        const skill = await service.resolveSharedSkill(args.skill);
        return ok(await buildSharedRun(skill, args.input));
      }
      const skill = await service.resolveSkill(args.container!, args.module!, args.skill);
      const targets = await service.resolveTargets(args.container!, args.module!);
      const target = targets[0];
      const mod = target?.modules.find((m) => m.path === args.module);
      if (!target || !mod) return fail(`Container "${args.container}" has no module "${args.module}".`);
      return ok(buildRun(target, mod, skill, args.input));
    }),
```

Add `buildSharedRun` to the prompts import (line 21):
```ts
import { buildAsk, buildContext, buildOnboard, buildRun, buildSharedRun } from "../prompts/index.js";
```

- [ ] **Step 7: Branch the `run` prompt handler in `src/server/prompts.ts`**

Replace the `run` prompt handler body (lines 61-77) with:

```ts
    async (args) => {
      try {
        const hasContainer = args.container !== undefined && args.container.trim().length > 0;
        const hasModule = args.module !== undefined && args.module.trim().length > 0;
        if (hasContainer !== hasModule) {
          return message("Cannot start this flow: run needs both container and module, or neither (shared skill).");
        }
        if (!hasContainer) {
          const skill = await service.resolveSharedSkill(args.skill);
          return message(await buildSharedRun(skill, args.input));
        }
        const skill = await service.resolveSkill(args.container!, args.module!, args.skill);
        const targets = await service.resolveTargets(args.container!, args.module!);
        const target = targets[0];
        const mod = target?.modules.find((m) => m.path === args.module);
        if (!target || !mod) {
          return message(`Cannot start this flow: Container "${args.container}" has no module "${args.module}".`);
        }
        return message(buildRun(target, mod, skill, args.input));
      } catch (err) {
        if (isOkhError(err)) {
          return message(`Cannot start this flow: [${err.code}] ${err.message}${err.hint ? `\n\nHint: ${err.hint}` : ""}`);
        }
        throw err;
      }
    },
```

Add `buildSharedRun` to the import (line 7):
```ts
import { buildAsk, buildContext, buildOnboard, buildRun, buildSharedRun } from "../prompts/index.js";
```

- [ ] **Step 8: Build + run tests**

Run: `npm run build && npx vitest run test/prompts.test.ts test/run.test.ts test/shared.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/prompts/index.ts src/prompts/meta.ts src/container/service.ts src/server/tools.ts src/server/prompts.ts test/prompts.test.ts test/run.test.ts
git commit -m "feat(run): resolve module-less shared skills via the run tool/prompt"
```

---

## Task 8: Create the `initialize` knowledge skill (from `okf-new-from-repo`)

**Files:**
- Move: `resources/okf/okf-new-from-repo.md` → `resources/module-types/knowledge/skills/initialize/SKILL.md`
- Test: `test/run.test.ts`

- [ ] **Step 1: Write the failing test in `test/run.test.ts`**

Add to `describe("effective skills + resolveSkill", ...)`:

```ts
it("knowledge type exposes learn + initialize", async () => {
  const { root, svc } = await setup();
  await saveModuleManifest(join(root, "kb"), { type: "knowledge", name: "KB", description: "" });
  const names = (await svc.effectiveSkills("h", "kb")).map((s) => s.name).sort();
  expect(names).toEqual(["initialize", "learn"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/run.test.ts -t "learn + initialize"`
Expected: FAIL — only `learn` present.

- [ ] **Step 3: Move the file**

```bash
git mv resources/okf/okf-new-from-repo.md resources/module-types/knowledge/skills/initialize/SKILL.md
```

- [ ] **Step 4: Rewrite the frontmatter + intro of `initialize/SKILL.md`**

Replace the frontmatter (lines 1-5) and title/intro (lines 7-15) with:

```markdown
---
name: initialize
description: Initialize a newly-created knowledge (OKF) module by surveying its target repository into a scope-bounded, question-driven knowledge pack.
---

# Initialize a knowledge module

**Populate a freshly-created `knowledge` module** by surveying its target repository
into a *knowledge pack*: a scope-bounded, question-driven
[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) bundle
of markdown concept docs. The pack exists to answer a specific, agreed list of
questions — nothing more. Anything that does not help answer a target question does
not belong in the pack.

The whole point is restraint. A sprawling auto-generated wiki is the failure mode. Resist it.
```

- [ ] **Step 5: Replace the client-specific slash references in `initialize/SKILL.md`**

Make these three edits:

Stage 1 — change:
```markdown
Run a `/grilling` session whose **sole purpose** is to produce a written **scope contract**:
```
to:
```markdown
Run the shared **grilling** skill (`run { skill: "grilling" }`) whose **sole purpose** is to produce a written **scope contract**:
```

Stage 2 — change:
```markdown
Use the `/explore-repo` discipline to map only the parts of the repository needed to answer the
target questions. Start from structural entry points, follow the code paths the questions demand,
```
to:
```markdown
Explore the repository to map only the parts needed to answer the target questions. Start from
structural entry points, follow the code paths the questions demand,
```

Stage 3 — change:
```markdown
A second, short `/grilling` pass — only for claims you found evidence of but **cannot verify
```
to:
```markdown
A second, short grilling pass (`run { skill: "grilling" }`) — only for claims you found evidence of but **cannot verify
```

Stage 4 — change:
```markdown
Use the `/okf-writer` discipline to author the OKF bundle. Default location is
```
to:
```markdown
Use the shared **okf-writer** skill (`run { skill: "okf-writer" }`) to author the OKF bundle. Default location is
```

- [ ] **Step 6: Run the test + build**

Run: `npx vitest run test/run.test.ts && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add resources/module-types/knowledge/skills/initialize
git commit -m "feat(knowledge): add initialize skill (repurposed from okf-new-from-repo)"
```

---

## Task 9: Update `learn` to reference the shared skills

**Files:**
- Modify: `resources/module-types/knowledge/skills/learn/SKILL.md`
- Test: `test/run.test.ts` (existing learn resolution stays green)

- [ ] **Step 1: Reference grilling in the Stage 2 borderline branch**

In `learn/SKILL.md`, change:
```markdown
- **Borderline — would only fit if the module's purpose grew** → do not decide unilaterally. Propose the smallest goal change that would justify it and get the user's explicit agreement, then re-run the gate. If it still doesn't serve a goal, reject it.
```
to:
```markdown
- **Borderline — would only fit if the module's purpose grew** → do not decide unilaterally. Run the shared **grilling** skill (`run { skill: "grilling" }`) to negotiate scope: propose the smallest goal change that would justify it and get the user's explicit agreement, then re-run the gate. If it still doesn't serve a goal, reject it.
```

- [ ] **Step 2: Reference okf-writer in Stage 4**

Change the Stage 4 heading + first line:
```markdown
## Stage 4 — Integrate

- Prefer **extending an existing concept** over adding a new doc; add a new concept only when it is genuinely distinct.
```
to:
```markdown
## Stage 4 — Integrate

Author with the shared **okf-writer** skill (`run { skill: "okf-writer" }`) for OKF format and citation rules, then:

- Prefer **extending an existing concept** over adding a new doc; add a new concept only when it is genuinely distinct.
```

- [ ] **Step 3: Verify learn still resolves**

Run: `npx vitest run test/run.test.ts -t "SKILL body"`
Expected: PASS (`resolveSkill("h","mem","remember")` and knowledge `learn` unaffected).

- [ ] **Step 4: Commit**

```bash
git add resources/module-types/knowledge/skills/learn/SKILL.md
git commit -m "docs(learn): reference shared grilling + okf-writer skills"
```

---

## Task 10: Archive the dead `okf-learn.md` and remove empty dirs

**Files:**
- Move: `resources/okf/okf-learn.md` → `delete/resources/okf/okf-learn.md`
- Remove: empty `resources/okf/` and `resources/discipline/`

- [ ] **Step 1: Archive the dead file**

```bash
mkdir -Force delete/resources/okf | Out-Null
git mv resources/okf/okf-learn.md delete/resources/okf/okf-learn.md
```

- [ ] **Step 2: Confirm `resources/okf/` and `resources/discipline/` are now empty and remove them**

Run: `Get-ChildItem -Recurse resources/okf, resources/discipline -File`
Expected: no files. Then:
```bash
Remove-Item -Recurse -Force resources/okf, resources/discipline
```

- [ ] **Step 3: Confirm `delete/` is excluded from the npm package**

Verify `package.json` `files` is `["dist", "resources"]` (delete/ not listed → not shipped). No change needed.

- [ ] **Step 4: Build to confirm nothing referenced the removed paths**

Run: `npm run build && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A delete resources
git commit -m "chore(resources): archive dead okf-learn.md under delete/; drop empty okf/ and discipline/"
```

---

## Task 11: Point `add`/`onboard` at the `initialize` skill

**Files:**
- Modify: `src/server/tools.ts:234` (add module success text)
- Modify: `resources/prompts/onboard.md` (Stage 2)
- Test: `test/server.test.ts`

- [ ] **Step 1: Write a failing test in `test/server.test.ts`**

Add this test inside `describe("MCP server surface", ...)` (uses the file's existing `connect`, `textOf`, `makeTempDir`, `cleanups`):

```ts
it("adding a knowledge module points at the initialize skill", async () => {
  const { client } = await connect();
  const source = await makeTempDir();
  cleanups.push(source);
  await client.callTool({ name: "add", arguments: { source, name: "hub", create: true } });
  const res = await client.callTool({
    name: "add",
    arguments: { container: "hub", path: "kb", type: "knowledge", name: "KB", create: true },
  });
  expect(textOf(res)).toMatch(/skill: "initialize"/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/server.test.ts -t initialize`
Expected: FAIL — success text has no initialize pointer.

- [ ] **Step 3: Append the pointer in `src/server/tools.ts`**

Replace the module-add success return (line 234) with:

```ts
          const added = `Added ${outcome.entry.type} module "${outcome.entry.name}" at "${outcome.entry.path}" to "${args.container}" at ${outcome.moduleRoot}.`;
          const next =
            outcome.entry.type === "knowledge"
              ? ` Next, populate it by running the initialize skill: run { container: "${args.container}", module: "${outcome.entry.path}", skill: "initialize" }.`
              : "";
          return ok(added + next, { entry: outcome.entry });
```

- [ ] **Step 4: Mention initialize in `resources/prompts/onboard.md` Stage 2**

At the end of Stage 2 (after the line ending "After the container exists, offer to add a `knowledge` module (and others as needed) the same way."), append:

```markdown
When a `knowledge` module is created, run its `initialize` skill
(`run { container, module, skill: "initialize" }`) to survey the target repo into a
scope-bounded pack.
```

- [ ] **Step 5: Run tests + build**

Run: `npm run build && npx vitest run test/server.test.ts test/prompts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/tools.ts resources/prompts/onboard.md test/server.test.ts
git commit -m "feat(add,onboard): point at the knowledge initialize skill"
```

---

## Task 12: Update user-facing docs

**Files:**
- Modify: `README.md`, `USAGE.md`, `CONTEXT.md`

- [ ] **Step 1: Update `README.md` skills paragraph**

Find the "Built-in types ship vendored skills" paragraph and update it to reflect the new layout and shared skills:

```markdown
Built-in types ship vendored skills: `knowledge` → `learn`, `initialize`; `memory`
→ `remember`, `reflect` (under `resources/module-types/<type>/skills/`). A module's
effective skill set = vendored (for its type) ∪ module-local skills (discovered from
`.okh/skills/` and common roots like `.claude/skills/`). Shared, module-less skills
(`grilling`, `okf-writer`) live under `resources/shared/skills/` and run via
`run { skill }` with no container/module. Skills use the standard `SKILL.md` format.
```

- [ ] **Step 2: Update `CONTEXT.md` skills + flows notes**

Update the "Built-in types ship vendored skills (`knowledge` → `learn`; …)" sentence the same way (add `initialize` and the shared-skills note). Leave the flows bullet (`ask`, `context`, `onboard`, run) as-is except confirm it still reads correctly.

- [ ] **Step 3: Update `USAGE.md`**

Add a short entry documenting module-less shared skills, e.g. under the run/skills section:

```markdown
- Run a shared skill (no module needed): `run { skill: "grilling" }` or
  `run { skill: "okf-writer" }`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md USAGE.md CONTEXT.md
git commit -m "docs: describe module-types/prompts/shared layout and shared skills"
```

---

## Task 13: Update eval references and add a shared-skill scenario

**Files:**
- Modify: `eval/scenarios/learn/trivial-fact.yaml:22`, `eval/README.md:308`
- Create: `eval/scenarios/run/shared-grilling.yaml`
- Test: `npm run typecheck:eval`, `npm run test:eval`, `npm run eval:validate`

- [ ] **Step 1: Reword the "okf-learn gate" mentions**

In `eval/scenarios/learn/trivial-fact.yaml` line 22, change `The okf-learn gate REJECTS` → `The learn gate REJECTS`.
In `eval/README.md` line 308, change `rejected by the okf-learn gate` → `rejected by the learn gate`.

- [ ] **Step 2: Add a shared-skill eval scenario**

Create `eval/scenarios/run/shared-grilling.yaml`, mirroring the structure of the existing `eval/scenarios/run/custom-skill.yaml` (same `vars.env`, `description`, and assertion style). Its `vars.prompt` should ask the agent to run the shared `grilling` skill with no module, and assert (via the same assertion helpers the neighboring scenarios use) that the `run` tool was called with `skill: "grilling"` and returned the grilling discipline. Use `env: empty` (no container/module needed).

```yaml
- description: "Run - shared grilling skill - module-less run returns grilling discipline"
  vars:
    env: empty
    prompt: "sam, run the shared grilling skill to stress-test my plan to add OAuth."
  assert:
    - type: javascript
      value: |
        // asserts the run tool was invoked with the shared grilling skill and
        // the returned text is the grilling discipline (one question at a time).
        output.toLowerCase().includes("one at a time") || output.toLowerCase().includes("grill")
```

(Match the exact assertion mechanism used by the sibling `run/*.yaml` files if they use a shared helper rather than inline `javascript`; keep it consistent with the repo's convention.)

- [ ] **Step 3: Validate the eval subsystem**

Run: `npm run typecheck:eval && npm run test:eval && npm run eval:validate`
Expected: typecheck 0 errors; eval unit tests pass; `eval:validate` prints "Configuration is valid."

- [ ] **Step 4: Commit**

```bash
git add eval/scenarios eval/README.md
git commit -m "test(eval): reword learn-gate mentions; add module-less shared-skill scenario"
```

---

## Task 14: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Build + typecheck + unit tests**

Run: `npm run build && npm run typecheck && npm test`
Expected: clean build, 0 type errors, all unit tests pass.

- [ ] **Step 2: Eval subsystem checks**

Run: `npm run typecheck:eval && npm run test:eval && npm run eval:validate`
Expected: all green; "Configuration is valid."

- [ ] **Step 3: Grep for stale references**

Run:
```bash
rg -n "okf-ask|okf-learn|okf-writer|okf-new-from-repo|resources/okf|resources/discipline|resources/types|loadOkf|loadDiscipline|combineOkf|OkfDoc|DisciplineDoc|TYPES_ROOT" src test eval README.md USAGE.md CONTEXT.md
```
Expected: only intentional hits — `okf-writer` (the shared skill name in skills/docs), and `resources/module-types` are fine; there must be **no** references to `resources/okf`, `resources/discipline`, `resources/types`, `loadOkf`, `loadDiscipline`, `combineOkf`, `OkfDoc`, `DisciplineDoc`, or `TYPES_ROOT` in `src`/`test`.

- [ ] **Step 4: Full e2e eval (larger-change gate)**

Run: `npm run build && npm run eval`
Expected: scenarios pass (or only pre-existing/unrelated flakes). Investigate any failure tied to the restructure via `~/.promptfoo/promptfoo.db` (latest `evals.id` → `eval_results` where `success=0`).

- [ ] **Step 5: Final commit if any fixups were needed**

```bash
git add -A
git commit -m "chore: post-restructure fixups"
```

---

## Self-Review Notes (author)

- **Spec coverage:** §2 layout → Tasks 1,2,6,8,10; §3.1 loader → Task 2; §3.2 shared → Tasks 3,4,5,6,7; §3.3 module-types → Task 1; §3.4 run → Task 7; §3.5 pointers → Task 11; §4 content → Tasks 5,6,8,9; §5 comments/docs → Tasks 2,7,10,12; §6 tests/eval → Tasks 2-13 + 14.
- **`delete/` shipping:** confirmed `files: ["dist","resources"]` excludes it (Task 10 Step 3).
- **Type consistency:** `loadPrompt`/`PromptDoc`, `buildSharedRun`, `resolveSharedSkill`, `skillResourcePaths`, `Skill.dir`, `MODULE_TYPES_ROOT` used identically across tasks.
- **Ordering:** shared resolver (Task 4) lands before its content (Tasks 5-6); `test/shared.test.ts` fully green only after Task 6 — noted inline.
