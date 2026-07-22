# Folder Module + `enter` Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in `folder` module type (an agent-ready space for unstructured work with an optional `AGENTS.md` and cross-agent skills) and a generic top-level `enter` tool that declares any module as the working folder and loads its `AGENTS.md` + skills into the client's context.

**Architecture:** `folder` is a new entry in `BUILTIN_MODULE_TYPES` with a `folderLoader` (top-level enumerate, `AGENTS.md`-or-placeholder overview, scaffold, skill-tree validate) and cross-agent skill roots (`.agents/skills`, `.claude/skills`, `.github/skills`). `enter` is a new read-only top-level MCP tool that reuses `service.resolveTargets` (for the module abs path) and `service.effectiveSkills` (for the skill list), reads `AGENTS.md` through a path-safe reader, and renders a prompt via a new `buildEnter()`. Loading `AGENTS.md` mirrors the existing read-and-inline pattern used by `use_agent`/`run`, not the `okh://` embed machinery.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, `@modelcontextprotocol/sdk`, Vitest. Prompt/tool text lives in `resources/` and is loaded at runtime.

## Global Constraints

- Language/module system: TypeScript ESM with NodeNext resolution. **All relative imports use the `.js` extension** (e.g. `import { x } from "./y.js"`), even for `.ts` sources.
- `resources/` sits at the package root; resolve resource files with `new URL("../../resources/...", import.meta.url)` (from `src/...`) or `../../../resources/...` from `src/modules/loaders/`, matching existing loaders.
- Adding a type to `BUILTIN_MODULE_TYPES` makes `LOADERS: Record<ModuleType, Loader>` require a loader for it — a compile-time guarantee; do not use `// @ts-ignore`.
- Adding a key to `toolShapes` makes `test/toolMeta.test.ts` require a matching `resources/tool-meta/<name>.md`; tool-meta `args` keys **must exactly equal** the Zod shape keys (`describeShape` throws otherwise).
- Honest framing (mirrors `use_agent`): `enter` **advises** the working folder and **loads** context; the executing MCP client owns and enforces the working directory. Never claim the Hub enforces the cwd or isolates writes.
- Scaffolding writes new files with the `wx` flag (fail if present), matching `knowledgeLoader`.
- Validation commands: `npm run typecheck` (server + app) and targeted `npx vitest run <file>`. There is no separate lint step. Full suite is `npm test`.
- Commit after every task with a `feat:`/`test:`/`docs:` message; keep each task's changes self-contained.

---

## File Structure

**New files:**
- `src/modules/loaders/folder.ts` — `folderLoader` (enumerate/overview/scaffold; validate added in Task 2).
- `src/modules/agentsFile.ts` — `readModuleAgentsFile()` path-safe `AGENTS.md` reader + `AgentsFileResult` type.
- `resources/module-types/folder/AGENTS-skeleton.md` — starter `AGENTS.md` written by scaffold.
- `resources/module-types/folder/skills/initialize/SKILL.md` — vendored `initialize` skill.
- `resources/docs/agents-md.md` — AGENTS.md best-practices doc, auto-served at `okh://docs/agents-md.md`.
- `resources/tool-meta/enter.md` — `enter` tool title/args/description.
- `resources/prompts/enter.md` — `enter` prompt template.
- `test/folder.test.ts` — folder loader + skill-root tests.
- `test/enter.test.ts` — `readModuleAgentsFile` + `buildEnter` tests.

**Modified files:**
- `src/modules/types.ts` — add `"folder"` to `BUILTIN_MODULE_TYPES`.
- `src/modules/registry.ts` — register `folderLoader`.
- `src/modules/skills.ts` — `FOLDER_SKILL_ROOTS` + `folder` case in `skillRootsForType`.
- `src/prompts/templates.ts` — add `"enter"` to `TemplateName`.
- `src/prompts/index.ts` — `buildEnter()` + render helpers.
- `src/server/toolSchemas.ts` — `enter` Zod shape.
- `src/server/tools.ts` — register the `enter` tool; import `buildEnter`, `readModuleAgentsFile`.
- `resources/docs/concepts.md`, `resources/docs/reference.md`, `resources/prompts/onboard.md`, `resources/tool-meta/add_module.md` — enumerate `folder` and document `enter`.
- `test/server.test.ts` — expect 17 tools including `enter`.

---

## Task 1: `folder` module type and loader

**Files:**
- Create: `src/modules/loaders/folder.ts`
- Create: `resources/module-types/folder/AGENTS-skeleton.md`
- Modify: `src/modules/types.ts:2`
- Modify: `src/modules/registry.ts`
- Test: `test/folder.test.ts`

**Interfaces:**
- Consumes: `Item`, `Loader` from `../types.js`.
- Produces: `folderLoader: Loader` (exported from `src/modules/loaders/folder.ts`) with `enumerate`, `overview`, `scaffold`, and `requiredFiles: []`. `validate` is added in Task 2.

- [ ] **Step 1: Write the failing test**

Create `test/folder.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { folderLoader } from "../src/modules/loaders/folder.js";
import { getLoader } from "../src/modules/registry.js";
import { isBuiltinType } from "../src/modules/types.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await makeTempDir("okh-folder-");
  cleanups.push(d);
  return d;
}
async function write(root: string, rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content, "utf8");
}

describe("folder loader", () => {
  it("is registered as a built-in type", () => {
    expect(isBuiltinType("folder")).toBe(true);
    expect(getLoader("folder")).toBe(folderLoader);
  });

  it("enumerates only top-level files and folders, excluding reserved entries", async () => {
    const root = await tmp();
    await write(root, "AGENTS.md", "# A\n");
    await write(root, "notes.md", "hi");
    await write(root, "data/report.csv", "a,b");
    await write(root, ".agents/skills/x/SKILL.md", "---\nname: x\n---\nbody");
    await write(root, ".github/skills/y/SKILL.md", "---\nname: y\n---\nbody");
    await write(root, "node_modules/pkg/index.js", "");
    await write(root, ".hidden", "");

    const items = await folderLoader.enumerate(root);
    const byPath = Object.fromEntries(items.map((i) => [i.path, i.type]));
    expect(Object.keys(byPath).sort()).toEqual(["data", "notes.md"]);
    expect(byPath["notes.md"]).toBe("file");
    expect(byPath["data"]).toBe("folder");
  });

  it("overview returns AGENTS.md when present, else a placeholder pointing to initialize", async () => {
    const root = await tmp();
    await write(root, "AGENTS.md", "# My Folder Guide\n");
    expect(await folderLoader.overview(root)).toContain("# My Folder Guide");

    const root2 = await tmp();
    const ov = await folderLoader.overview(root2);
    expect(ov).toMatch(/initialize/i);
    expect(ov).not.toContain("My Folder Guide");
  });

  it("has no required files (valid without AGENTS.md)", () => {
    expect(folderLoader.requiredFiles ?? []).toEqual([]);
  });

  it("scaffold writes a starter AGENTS.md and an empty .agents/skills dir", async () => {
    const root = await tmp();
    await folderLoader.scaffold!(root);
    const overview = await folderLoader.overview(root);
    expect(overview.length).toBeGreaterThan(0);
    expect(overview).not.toMatch(/Run the initialize skill/i); // real skeleton, not the placeholder
    const items = await folderLoader.enumerate(root); // .agents is excluded from enumeration
    expect(items.map((i) => i.path)).not.toContain(".agents");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/folder.test.ts`
Expected: FAIL — cannot resolve `../src/modules/loaders/folder.js` / `isBuiltinType("folder")` is false.

- [ ] **Step 3: Add `folder` to the built-in types**

Modify `src/modules/types.ts` line 2:

```ts
export const BUILTIN_MODULE_TYPES = ["knowledge", "skills", "memory", "llmwiki", "agents", "workspace", "folder"] as const;
```

- [ ] **Step 4: Create the AGENTS.md skeleton resource**

Create `resources/module-types/folder/AGENTS-skeleton.md` with this exact content (the file itself contains a nested `bash` code fence):

````markdown
# AGENTS.md

> Instructions for AI agents working in this folder. Keep it short, concrete, and
> current. Replace every bracketed prompt below with facts discovered from the folder,
> and delete sections that do not apply. This is a README for agents, not for humans.

## Purpose

[One or two sentences: what this folder is for and who relies on it.]

## Commands

[The exact commands an agent runs here — build, run, format — each with its flags.
Put the ones used most often first. Example:]

```bash
# npm run build
```

## Testing

[How to run the tests and what "green" means. Name the single most useful command.]

## Project structure

[Where the important files live and what each top-level area is for.]

## Code style

[Language/versions, formatting, and conventions specific to this folder.]

## Git workflow

[Branch/commit/PR expectations, if any.]

## Boundaries

- Never commit secrets, tokens, or credentials.
- [Anything an agent must never touch or must ask before doing.]

## Skills

[If this folder has skills under `.agents/skills/`, `.claude/skills/`, or
`.github/skills/`, name them and when to use each.]
````

- [ ] **Step 5: Create the loader**

Create `src/modules/loaders/folder.ts`:

```ts
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Item, Loader } from "../types.js";

// Starter AGENTS.md written into a new folder module; resolves from src (tsx) and dist (built).
const AGENTS_SKELETON_URL = new URL(
  "../../../resources/module-types/folder/AGENTS-skeleton.md",
  import.meta.url,
);

// Top-level entries never surfaced as work items: the entry-point file, the reserved
// skill/config roots, and common build/dependency noise.
const EXCLUDED_ENTRIES = new Set([
  "AGENTS.md",
  ".okh",
  ".agents",
  ".claude",
  ".github",
  "node_modules",
  "__pycache__",
  "vendor",
  "venv",
]);

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function enumerate(moduleRoot: string): Promise<Item[]> {
  let entries;
  try {
    entries = await readdir(moduleRoot, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const items: Item[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || EXCLUDED_ENTRIES.has(entry.name)) continue;
    if (entry.isDirectory()) {
      items.push({ path: entry.name, title: entry.name, description: "", type: "folder" });
    } else if (entry.isFile()) {
      items.push({ path: entry.name, title: entry.name, description: "", type: "file" });
    }
  }
  return items;
}

async function overview(moduleRoot: string): Promise<string> {
  try {
    return await readFile(join(moduleRoot, "AGENTS.md"), "utf8");
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  return "# Folder\n\n_No AGENTS.md yet. Run the initialize skill to author one._\n";
}

async function scaffold(moduleRoot: string): Promise<void> {
  await mkdir(join(moduleRoot, ".agents", "skills"), { recursive: true });
  const skeleton = await readFile(fileURLToPath(AGENTS_SKELETON_URL), "utf8");
  await writeFile(join(moduleRoot, "AGENTS.md"), skeleton, { encoding: "utf8", flag: "wx" });
}

export const folderLoader: Loader = {
  enumerate,
  overview,
  requiredFiles: [],
  scaffold,
};
```

- [ ] **Step 6: Register the loader**

Modify `src/modules/registry.ts` — add the import after the workspace import and the record entry after `workspace`:

```ts
import { folderLoader } from "./loaders/folder.js";
```

```ts
const LOADERS: Record<ModuleType, Loader> = {
  knowledge: knowledgeLoader,
  skills: skillsLoader,
  memory: memoryLoader,
  llmwiki: llmwikiLoader,
  agents: agentsLoader,
  workspace: workspaceLoader,
  folder: folderLoader,
};
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/folder.test.ts`
Expected: PASS (all folder-loader cases).

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no missing-loader error on `LOADERS`).

- [ ] **Step 9: Commit**

```bash
git add src/modules/loaders/folder.ts src/modules/types.ts src/modules/registry.ts \
  resources/module-types/folder/AGENTS-skeleton.md test/folder.test.ts
git commit -m "feat: add folder module type and loader"
```

---

## Task 2: Folder skill roots + skill-tree validation

**Files:**
- Modify: `src/modules/skills.ts:23-41`
- Modify: `src/modules/loaders/folder.ts` (add `validate`)
- Test: `test/folder.test.ts` (extend)

**Interfaces:**
- Consumes: `discoverModuleSkills`, `validateModuleSkills`, `MODULE_SKILL_ROOTS`, `MODULE_ROOT_SKILL_ROOT` from `../skills.js`.
- Produces: `FOLDER_SKILL_ROOTS` (exported `readonly [".agents/skills", ".claude/skills", ".github/skills"]`); `skillRootsForType("folder")` returns `FOLDER_SKILL_ROOTS`; `folderLoader.validate(moduleRoot)` returns skill-tree issue strings.

- [ ] **Step 1: Write the failing test**

Append to `test/folder.test.ts`:

```ts
import { discoverModuleSkills, skillRootsForType, FOLDER_SKILL_ROOTS } from "../src/modules/skills.js";

describe("folder skill roots", () => {
  it("skillRootsForType('folder') returns the cross-agent roots in precedence order", () => {
    expect(skillRootsForType("folder")).toEqual([
      ".agents/skills",
      ".claude/skills",
      ".github/skills",
    ]);
    expect(FOLDER_SKILL_ROOTS).toEqual([".agents/skills", ".claude/skills", ".github/skills"]);
  });

  it("discovers skills from all three roots, with .agents winning name collisions", async () => {
    const root = await tmp();
    await write(root, ".agents/skills/shared/SKILL.md", "---\nname: shared\ndescription: from agents\n---\nA");
    await write(root, ".claude/skills/shared/SKILL.md", "---\nname: shared\ndescription: from claude\n---\nB");
    await write(root, ".github/skills/only-gh/SKILL.md", "---\nname: only-gh\ndescription: gh\n---\nC");

    const skills = await discoverModuleSkills(root, skillRootsForType("folder"));
    const byName = Object.fromEntries(skills.map((s) => [s.name, s.description]));
    expect(byName["shared"]).toBe("from agents");
    expect(byName["only-gh"]).toBe("gh");
  });

  it("validate surfaces a malformed SKILL.md via the skill-scan machinery", async () => {
    const root = await tmp();
    // A directory named like a skill leaf but with a non-file SKILL.md is malformed.
    await mkdir(join(root, ".agents/skills/broken/SKILL.md"), { recursive: true });
    const issues = await folderLoader.validate!(root);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(" ")).toMatch(/broken/);
  });

  it("validate returns no issues for a clean folder", async () => {
    const root = await tmp();
    await write(root, ".agents/skills/ok/SKILL.md", "---\nname: ok\ndescription: fine\n---\nbody");
    expect(await folderLoader.validate!(root)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/folder.test.ts`
Expected: FAIL — `FOLDER_SKILL_ROOTS` is not exported and `skillRootsForType("folder")` returns `MODULE_SKILL_ROOTS`; `folderLoader.validate` is undefined.

- [ ] **Step 3: Add the folder skill roots**

Modify `src/modules/skills.ts`. After the `MODULE_SKILL_ROOTS` declaration (line 23), add:

```ts
/** Cross-agent skill roots for `folder` modules, in precedence order: `.agents/skills`
 * (canonical) shadows `.claude/skills`, which shadows `.github/skills`. No native
 * `.okh/skills` — a folder is deliberately portable to Claude Code / Copilot on disk. */
export const FOLDER_SKILL_ROOTS = [".agents/skills", ".claude/skills", ".github/skills"] as const;
```

Replace the body of `skillRootsForType` (lines 37-41):

```ts
export function skillRootsForType(moduleType: string): readonly string[] {
  if (moduleType === "skills") return [...MODULE_SKILL_ROOTS, MODULE_ROOT_SKILL_ROOT];
  if (moduleType === "folder") return FOLDER_SKILL_ROOTS;
  return MODULE_SKILL_ROOTS;
}
```

- [ ] **Step 4: Add `validate` to the loader**

Modify `src/modules/loaders/folder.ts`. Add the import and a `validate` function, then include it in the exported loader:

```ts
import { validateModuleSkills, FOLDER_SKILL_ROOTS } from "../skills.js";
```

```ts
async function validate(moduleRoot: string): Promise<string[]> {
  return validateModuleSkills(moduleRoot, FOLDER_SKILL_ROOTS);
}

export const folderLoader: Loader = {
  enumerate,
  overview,
  requiredFiles: [],
  scaffold,
  validate,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/folder.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/skills.ts src/modules/loaders/folder.ts test/folder.test.ts
git commit -m "feat: folder skill roots and skill-tree validation"
```

---

## Task 3: Vendored `initialize` skill + `agents-md.md` doc

**Files:**
- Create: `resources/module-types/folder/skills/initialize/SKILL.md`
- Create: `resources/docs/agents-md.md`
- Test: `test/folder.test.ts` (extend)

**Interfaces:**
- Consumes: `vendoredSkills` from `../src/modules/vendored.js`, `mergeSkills`/`discoverModuleSkills` from `../src/modules/skills.js`.
- Produces: a vendored `initialize` skill for `folder`, mergeable and overridable by a local same-named skill. `okh://docs/agents-md.md` is auto-served by the docs `FileTreeResourceProvider` (no code registration needed).

- [ ] **Step 1: Write the failing test**

Append to `test/folder.test.ts`:

```ts
import { vendoredSkills } from "../src/modules/vendored.js";
import { mergeSkills } from "../src/modules/skills.js";

describe("folder vendored initialize skill", () => {
  it("ships an initialize skill that declares the agents-md doc dependency", async () => {
    const vendored = await vendoredSkills("folder");
    const init = vendored.find((s) => s.name === "initialize");
    expect(init).toBeDefined();
    expect(init!.resourceUris ?? []).toContain("okh://docs/agents-md.md");
  });

  it("a local initialize skill overrides the vendored one", async () => {
    const root = await tmp();
    await write(root, ".agents/skills/initialize/SKILL.md", "---\nname: initialize\ndescription: local override\n---\nlocal body");
    const merged = mergeSkills(
      await vendoredSkills("folder"),
      await discoverModuleSkills(root, skillRootsForType("folder")),
    );
    const inits = merged.filter((s) => s.name === "initialize");
    expect(inits).toHaveLength(1);
    expect(inits[0]!.description).toBe("local override");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/folder.test.ts`
Expected: FAIL — `vendoredSkills("folder")` is empty (no `resources/module-types/folder/skills/`).

- [ ] **Step 3: Create the best-practices doc**

Create `resources/docs/agents-md.md`:

```markdown
---
title: AGENTS.md best practices
description: How to write a high-signal AGENTS.md for a folder module, distilled from the agents.md standard and analysis of thousands of real files.
---

# AGENTS.md best practices

`AGENTS.md` is a "README for agents": freeform Markdown that tells an AI coding agent
how to work in a folder. It is machine-focused and distinct from a human `README.md`.
Keep it short, specific, and current — a sprawling file is the failure mode.

## Six core areas

Cover these where they apply; omit any that do not:

1. **Commands** — the exact commands to build, run, and format, each with its flags.
   Put the most-used commands first; agents copy these verbatim.
2. **Testing** — how to run the tests and what "passing" means. Name the single most
   useful command.
3. **Project structure** — where important files live and what each top-level area does.
4. **Code style** — language and versions, formatting rules, and naming conventions.
5. **Git workflow** — branch, commit, and PR expectations, if any.
6. **Boundaries** — explicit "never touch" rules. "Never commit secrets" is the single
   most common and most valuable constraint.

## Writing guidance

- Prefer executable commands and one real code example over paragraphs of prose.
- Be specific about the stack and versions; vague guidance produces vague behavior.
- State boundaries as explicit prohibitions ("never …"), not soft preferences.
- Point to the folder's own skills (`.agents/skills/`, `.claude/skills/`,
  `.github/skills/`) and say when to use each.
- Never invent commands, paths, versions, or tools — discover them from the folder.
- Iterate: tighten the file whenever an agent makes a mistake it could have avoided.

## Nesting

In a nested layout, the `AGENTS.md` nearest an edited file takes precedence. A folder
module's root `AGENTS.md` governs its whole tree unless a deeper `AGENTS.md` overrides
it for a subtree.
```

- [ ] **Step 4: Create the vendored initialize skill**

Create `resources/module-types/folder/skills/initialize/SKILL.md`:

```markdown
---
name: initialize
description: Author or improve this folder module's AGENTS.md so agents can work in it effectively.
resources:
  - okh://docs/agents-md.md
---

# Initialize a folder module

This `folder` module is a space for unstructured work. Give it a high-signal
`AGENTS.md` at the module root so any agent — Claude Code, GitHub Copilot, or a client
that called `enter` — can work here effectively. Apply the embedded AGENTS.md
best-practices doc, but ground every line in this folder's actual contents.

## Stage 1 — Learn the folder

Call `inspect { container, module }` and read any existing `AGENTS.md` and top-level
files to learn the folder's real purpose, stack, commands, and conventions. Never
invent commands, paths, versions, or tools; discover them here or ask the user one
focused question at a time when a decision materially changes the guidance.

## Stage 2 — Write AGENTS.md

Write a concise `AGENTS.md` at the module root covering the six core areas from the
embedded best-practices doc where they apply to this folder:

1. **Purpose** — what the folder is for and who relies on it.
2. **Commands** — exact build/run/format commands, most-used first, with flags.
3. **Testing** — how to run tests and what "passing" means.
4. **Project structure** — where important files live.
5. **Code style** — languages, versions, formatting, naming.
6. **Git workflow** — branch/commit/PR expectations, if any.
7. **Boundaries** — explicit "never touch" rules; always include "never commit secrets".

Prefer executable commands and one real example over prose. If the folder has skills
under `.agents/skills/`, `.claude/skills/`, or `.github/skills/`, name them and say when
to use each.

## Stage 3 — Persist and verify

Write only `AGENTS.md` (and skill files if you author skills). Call
`inspect { container, module }` again to confirm the module is valid, then follow the
run tool's write policy and sync the changed container.

Report what you wrote and any boundary you set. Do not claim the Hub enforces commands,
permissions, or isolation; the executing client owns those controls.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/folder.test.ts`
Expected: PASS (vendored initialize present with the doc dependency; local override wins).

- [ ] **Step 6: Commit**

```bash
git add resources/module-types/folder/skills/initialize/SKILL.md resources/docs/agents-md.md test/folder.test.ts
git commit -m "feat: vendored folder initialize skill and AGENTS.md best-practices doc"
```

---

## Task 4: Path-safe `AGENTS.md` reader

**Files:**
- Create: `src/modules/agentsFile.ts`
- Test: `test/enter.test.ts`

**Interfaces:**
- Consumes: `isPathWithin` from `./pathSafety.js`.
- Produces:
  - `type AgentsFileResult = { status: "present"; content: string } | { status: "absent" } | { status: "unsafe"; reason: string }`
  - `readModuleAgentsFile(moduleRoot: string): Promise<AgentsFileResult>`
  - `const MAX_AGENTS_FILE_BYTES = 256 * 1024`

- [ ] **Step 1: Write the failing test**

Create `test/enter.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { readModuleAgentsFile, MAX_AGENTS_FILE_BYTES } from "../src/modules/agentsFile.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await makeTempDir("okh-enter-");
  cleanups.push(d);
  return d;
}

describe("readModuleAgentsFile", () => {
  it("returns present with the content when AGENTS.md is a regular file", async () => {
    const root = await tmp();
    await writeFile(join(root, "AGENTS.md"), "# Guide\nline\n", "utf8");
    const result = await readModuleAgentsFile(root);
    expect(result).toEqual({ status: "present", content: "# Guide\nline\n" });
  });

  it("returns absent when there is no AGENTS.md", async () => {
    const root = await tmp();
    expect(await readModuleAgentsFile(root)).toEqual({ status: "absent" });
  });

  it("rejects a symlinked AGENTS.md as unsafe", async () => {
    const root = await tmp();
    const outside = await tmp();
    await writeFile(join(outside, "secret.md"), "secret", "utf8");
    await symlink(join(outside, "secret.md"), join(root, "AGENTS.md"));
    const result = await readModuleAgentsFile(root);
    expect(result.status).toBe("unsafe");
  });

  it("rejects an AGENTS.md that exceeds the byte cap", async () => {
    const root = await tmp();
    await writeFile(join(root, "AGENTS.md"), "x".repeat(MAX_AGENTS_FILE_BYTES + 1), "utf8");
    const result = await readModuleAgentsFile(root);
    expect(result.status).toBe("unsafe");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/enter.test.ts`
Expected: FAIL — cannot resolve `../src/modules/agentsFile.js`.

- [ ] **Step 3: Create the reader**

Create `src/modules/agentsFile.ts`:

```ts
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isPathWithin } from "./pathSafety.js";

export const MAX_AGENTS_FILE_BYTES = 256 * 1024;

export type AgentsFileResult =
  | { status: "present"; content: string }
  | { status: "absent" }
  | { status: "unsafe"; reason: string };

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Read `<moduleRoot>/AGENTS.md` with the same guards used for agent profiles:
 * no symlinks, resolved path must stay within the module root, 256 KiB cap, UTF-8.
 * Returns `absent` when the file does not exist, `unsafe` (with a reason) when it
 * exists but cannot be read safely, and `present` (with content) otherwise.
 */
export async function readModuleAgentsFile(moduleRoot: string): Promise<AgentsFileResult> {
  const path = join(moduleRoot, "AGENTS.md");
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if (isNotFound(err)) return { status: "absent" };
    return { status: "unsafe", reason: "the file could not be inspected" };
  }
  if (info.isSymbolicLink()) return { status: "unsafe", reason: "symbolic links are not allowed" };
  if (!info.isFile()) return { status: "unsafe", reason: "AGENTS.md is not a regular file" };

  let moduleRootReal: string;
  let candidateReal: string;
  try {
    moduleRootReal = await realpath(moduleRoot);
    candidateReal = await realpath(path);
  } catch {
    return { status: "unsafe", reason: "the file could not be resolved" };
  }
  if (!isPathWithin(moduleRootReal, candidateReal)) {
    return { status: "unsafe", reason: "the file resolves outside the module root" };
  }

  let handle;
  try {
    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    handle = await open(candidateReal, constants.O_RDONLY | noFollow);
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) return { status: "unsafe", reason: "AGENTS.md is not a regular file" };
    if (openedInfo.size > MAX_AGENTS_FILE_BYTES) {
      return { status: "unsafe", reason: `AGENTS.md exceeds the ${MAX_AGENTS_FILE_BYTES}-byte limit` };
    }
    const bytes = await handle.readFile();
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return { status: "unsafe", reason: "AGENTS.md is not valid UTF-8" };
    }
    return { status: "present", content };
  } catch {
    return { status: "unsafe", reason: "AGENTS.md could not be read safely" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/enter.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/agentsFile.ts test/enter.test.ts
git commit -m "feat: path-safe AGENTS.md reader for the enter tool"
```

---

## Task 5: `buildEnter()` prompt renderer + `enter.md` template

**Files:**
- Modify: `src/prompts/templates.ts:8-16`
- Create: `resources/prompts/enter.md`
- Modify: `src/prompts/index.ts`
- Test: `test/enter.test.ts` (extend)

**Interfaces:**
- Consumes: `ResolvedContainer`, `ResolvedModule` from `../container/service.js`; `Skill` from `../modules/skills.js`; `AgentsFileResult` from `../modules/agentsFile.js`; `renderTemplate` from `./templates.js`; `formatSyncDescriptor` from `../util/syncFormat.js`.
- Produces: `buildEnter(target: ResolvedContainer, module: ResolvedModule, skills: readonly Skill[], agents: AgentsFileResult): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Append to `test/enter.test.ts`:

```ts
import { buildEnter } from "../src/prompts/index.js";
import type { ResolvedContainer, ResolvedModule } from "../src/container/service.js";
import type { Skill } from "../src/modules/skills.js";
import type { AgentsFileResult } from "../src/modules/agentsFile.js";

function fakeTarget(): ResolvedContainer {
  return {
    name: "hub",
    backend: "local",
    sync: { mode: "auto", config: {} },
    syncActions: [],
    root: "/abs/hub",
    modules: [],
  };
}
function fakeModule(type = "folder"): ResolvedModule {
  return { type, path: "work", description: "", absPath: "/abs/hub/work" };
}
const skill = (name: string, description = ""): Skill => ({ name, description, body: "b", source: "vendored" });

describe("buildEnter", () => {
  it("declares the working folder and appends the write policy", async () => {
    const text = await buildEnter(fakeTarget(), fakeModule(), [], { status: "absent" });
    expect(text).toContain("/abs/hub/work");
    expect(text).toMatch(/working directory/i);
    expect(text).toMatch(/Write policy/i);
    expect(text).toMatch(/sync/i);
  });

  it("inlines AGENTS.md content when present", async () => {
    const agents: AgentsFileResult = { status: "present", content: "# Folder Guide\nDo the thing." };
    const text = await buildEnter(fakeTarget(), fakeModule(), [], agents);
    expect(text).toContain("# Folder Guide");
    expect(text).toContain("Do the thing.");
  });

  it("notes an absent AGENTS.md and hints initialize for folder modules", async () => {
    const text = await buildEnter(fakeTarget(), fakeModule("folder"), [], { status: "absent" });
    expect(text).toMatch(/No .*AGENTS\.md/i);
    expect(text).toMatch(/initialize/i);
  });

  it("omits the initialize hint for non-folder modules", async () => {
    const text = await buildEnter(fakeTarget(), fakeModule("knowledge"), [], { status: "absent" });
    expect(text).toMatch(/No .*AGENTS\.md/i);
    expect(text).not.toMatch(/skill: "initialize"/);
  });

  it("reports an unsafe AGENTS.md with its reason and does not inline it", async () => {
    const agents: AgentsFileResult = { status: "unsafe", reason: "symbolic links are not allowed" };
    const text = await buildEnter(fakeTarget(), fakeModule(), [], agents);
    expect(text).toMatch(/not loaded|not read|could not/i);
    expect(text).toContain("symbolic links are not allowed");
  });

  it("lists the module's skills, and states none when empty", async () => {
    const withSkills = await buildEnter(fakeTarget(), fakeModule(), [skill("initialize", "author AGENTS.md")], { status: "absent" });
    expect(withSkills).toContain("initialize");
    expect(withSkills).toContain("author AGENTS.md");

    const noSkills = await buildEnter(fakeTarget(), fakeModule(), [], { status: "absent" });
    expect(noSkills).toMatch(/no skills/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/enter.test.ts`
Expected: FAIL — `buildEnter` is not exported; `renderTemplate("enter", …)` has no template.

- [ ] **Step 3: Register the template name**

Modify `src/prompts/templates.ts` — add `"enter"` to the `TemplateName` union (after `"run"`):

```ts
export type TemplateName =
  | "ask"
  | "context"
  | "onboard"
  | "run"
  | "enter"
  | "help"
  | "instructions"
  | "add_module"
  | "dream";
```

- [ ] **Step 4: Create the prompt template**

Create `resources/prompts/enter.md`:

```markdown
{{var:target}}You are now working in this module. Treat the module path above as your
working directory: create and modify files only inside it unless the user directs you
elsewhere. Open Knowledge Hub advises this working folder; your client owns and enforces
the actual working directory and every change you make.

# AGENTS.md
{{var:agents}}

# Skills
{{var:skills}}

Run any skill with `run { container, module, skill }` to get its full instructions.

{{prompt:partials/write-policy.md}}
```

- [ ] **Step 5: Add `buildEnter` and helpers**

Modify `src/prompts/index.ts`. Add the import near the top (after the existing `Skill` import):

```ts
import type { AgentsFileResult } from "../modules/agentsFile.js";
```

Then add, after `buildRun` (around line 84):

```ts
function renderEnterSkills(skills: readonly Skill[]): string {
  if (skills.length === 0) return "_This module has no skills._";
  return skills
    .map((s) => `- \`${s.name}\`${s.description ? ` — ${s.description}` : ""}`)
    .join("\n");
}

function renderEnterAgents(agents: AgentsFileResult, module: ResolvedModule): string {
  if (agents.status === "present") return agents.content.trim();
  if (agents.status === "unsafe") {
    return `_An \`AGENTS.md\` exists at the module root but was not loaded: ${agents.reason}._`;
  }
  const hint =
    module.type === "folder"
      ? ' Run `run { container, module, skill: "initialize" }` to author one.'
      : "";
  return `_No \`AGENTS.md\` at the module root._${hint}`;
}

/** Render the "enter" result: working-folder declaration + AGENTS.md + skills + write policy. */
export function buildEnter(
  target: ResolvedContainer,
  module: ResolvedModule,
  skills: readonly Skill[],
  agents: AgentsFileResult,
): Promise<string> {
  const targetBlock =
    `# Target\n`
    + `- Module: ${module.type} · \`${module.path}\` → \`${module.absPath}\`\n`
    + `- Container: ${target.name} (${target.backend}, sync: ${formatSyncDescriptor(target.sync)}) — \`${target.root}\`\n\n`;
  return renderTemplate("enter", {
    vars: {
      target: targetBlock,
      agents: renderEnterAgents(agents, module),
      skills: renderEnterSkills(skills),
    },
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/enter.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/prompts/templates.ts src/prompts/index.ts resources/prompts/enter.md test/enter.test.ts
git commit -m "feat: buildEnter prompt renderer and enter template"
```

---

## Task 6: Register the `enter` tool

**Files:**
- Modify: `src/server/toolSchemas.ts:86` (after `dream`)
- Create: `resources/tool-meta/enter.md`
- Modify: `src/server/tools.ts` (imports + registration after `dream`, ~line 681)
- Modify: `test/server.test.ts:74-94`

**Interfaces:**
- Consumes: `service.resolveTargets`, `service.effectiveSkills`; `readModuleAgentsFile`; `buildEnter`; `toolReg`, `handler`, `isBlank`, `fail`, `ok`.
- Produces: a registered read-only `enter` tool with input `{ container: string; module: string }`.

- [ ] **Step 1: Write the failing test**

Modify `test/server.test.ts`. Change the count text and add `"enter"` to the sorted list (it sorts between `dream` and `help`):

```ts
  it("exposes exactly the 17 tools and no prompts", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "add_container",
      "add_module",
      "ask",
      "capabilities",
      "config",
      "context",
      "dream",
      "enter",
      "help",
      "inspect",
      "onboard",
      "read_resource",
      "run",
      "sync",
      "todos",
      "use_agent",
      "workspace",
    ]);
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
  });
```

Also add an annotations assertion in the existing "declares accurate tool annotations" test (after the `use_agent` lines, ~line 285):

```ts
    expect(byName.enter!.readOnlyHint).toBe(true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL — only 16 tools; `enter` missing.

- [ ] **Step 3: Add the Zod shape**

Modify `src/server/toolSchemas.ts` — add after the `dream` entry (line 86):

```ts
  enter: { container: z.string(), module: z.string() },
```

- [ ] **Step 4: Create the tool-meta**

Create `resources/tool-meta/enter.md`:

```markdown
---
title: Enter a module to work in it
args:
  container: Container that owns the module to enter.
  module: Module folder name to enter and work in.
---
Declare a module as your working folder and load its context before you start working
in it. Returns the module's absolute path as the working directory, inlines the module's
`AGENTS.md` when one is present, lists the module's runnable skills, and states the write
policy. Read-only and works for every module type. Open Knowledge Hub advises the working
folder and loads context; your client owns and enforces the actual working directory.
```

- [ ] **Step 5: Register the tool**

Modify `src/server/tools.ts`. Add `buildEnter` to the prompts import block (lines 22-30):

```ts
import {
  buildAddModule,
  buildAsk,
  buildContext,
  buildDream,
  buildEnter,
  buildHelp,
  buildOnboard,
  buildRun,
} from "../prompts/index.js";
```

Add the reader import after the `renderUseAgentResult` import (line 45):

```ts
import { readModuleAgentsFile } from "../modules/agentsFile.js";
```

Register the tool immediately after the `dream` registration (just before the closing `}` of `registerTools`, line 681):

```ts
  server.registerTool(
    "enter",
    { ...(await toolReg("enter")), annotations: { readOnlyHint: true } },
    handler(async (args: { container: string; module: string }) => {
      if (isBlank(args.container)) return fail("container cannot be empty.");
      if (isBlank(args.module)) return fail("module cannot be empty.");
      const targets = await service.resolveTargets(args.container, args.module);
      const target = targets[0];
      const mod = target?.modules.find((m) => m.path === args.module);
      if (!target || !mod) return fail(`Container "${args.container}" has no module "${args.module}".`);
      const [skills, agents] = await Promise.all([
        service.effectiveSkills(args.container, args.module),
        readModuleAgentsFile(mod.absPath),
      ]);
      return ok(await buildEnter(target, mod, skills, agents));
    }),
  );
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/server.test.ts test/toolMeta.test.ts`
Expected: PASS (17 tools including `enter`; enter tool-meta loads and its args match its schema).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/toolSchemas.ts src/server/tools.ts resources/tool-meta/enter.md test/server.test.ts
git commit -m "feat: register the enter tool"
```

---

## Task 7: Documentation wiring

**Files:**
- Modify: `resources/docs/concepts.md:41-95`
- Modify: `resources/docs/reference.md:18-19, 61-70`
- Modify: `resources/prompts/onboard.md:41-42`
- Modify: `resources/tool-meta/add_module.md:6`

**Interfaces:** none (documentation only). No new tests; correctness is covered by `test/toolMeta.test.ts` (renders `add_module.md`) and the build.

- [ ] **Step 1: Update `concepts.md` — module types**

Modify `resources/docs/concepts.md` lines 43-45:

```markdown
Built-in types are `knowledge`, `memory`, `llmwiki`, `skills`, `agents`,
`workspace`, and `folder`. A `folder` module is an agent-ready space for unstructured
work: freeform files at the top level, an optional `AGENTS.md`, and skills under
`.agents/skills/`, `.claude/skills/`, or `.github/skills/`. Any other non-empty type is
custom and uses the generic file-listing loader.
```

- [ ] **Step 2: Update `concepts.md` — skill precedence note**

In the "Skill precedence" list (lines 54-57), append a bullet after item 3:

```markdown
4. For a `folder` module, skills from `.agents/skills/`, `.claude/skills/`, and
   `.github/skills/` (in that precedence order) instead of `.okh/skills/`.
```

- [ ] **Step 3: Update `concepts.md` — routing**

In the "Routing" list, add a bullet before "Explain OKH" (line 94):

```markdown
- Start working in a module (any type): call `enter { container, module }`. It declares
  the module's path as the working folder, inlines its `AGENTS.md` when present, and
  lists its skills.
```

- [ ] **Step 4: Update `reference.md` — tools table + module-type table**

In the tools table (lines 12-27), add this row immediately after the `run` row (line 22), since `enter` is the other "start working in a module" tool:

```markdown
| `enter` | container, module | Declare a module as the working folder; load its `AGENTS.md` (when present) and skills into context. |
```

In the "Built-in module types and skills" table (after the `workspace` row, line 70), add:

```markdown
| `folder` | Optional root `AGENTS.md`, top-level work files, cross-agent skills | `initialize` |
```

- [ ] **Step 5: Update `onboard.md` — module types list**

Modify `resources/prompts/onboard.md` lines 41-42:

```markdown
- **Module** — a typed subfolder inside a container: `knowledge`, `skills`,
  `memory`, `llmwiki`, `agents`, `workspace`, or `folder`.
```

- [ ] **Step 6: Update `add_module.md` tool-meta type arg**

Modify `resources/tool-meta/add_module.md` line 6:

```markdown
  type: "Module type: a built-in (knowledge, skills, memory, llmwiki, agents, workspace, folder) or a custom type name (required when create:true)."
```

- [ ] **Step 7: Verify docs render and tool-meta still parses**

Run: `npx vitest run test/toolMeta.test.ts`
Expected: PASS (`add_module` renders without error).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add resources/docs/concepts.md resources/docs/reference.md resources/prompts/onboard.md resources/tool-meta/add_module.md
git commit -m "docs: document the folder module type and enter tool"
```

---

## Final verification

- [ ] **Run the full test suite**

Run: `npm test`
Expected: PASS (all suites, including `folder`, `enter`, `server`, `toolMeta`).

- [ ] **Typecheck server + app**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Manual smoke (optional)**

Build and start the MCP inspector, add a container, `add_module { type: "folder", create: true }`, run `initialize`, then call `enter { container, module }` and confirm it returns the working path, the AGENTS.md (or the initialize hint), and the skill list.

Run: `npm run inspect`
