# OKH Module System Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make modules self-contained (per-module manifest + auto-discovery), retire the container manifest, and move hub-wide write verbs into per-type skills invoked through a generic `run` tool (plus a custom module type and skill discovery).

**Architecture:** Two phases. **Phase 1** replaces the container manifest with per-module `<module>/.okh/module.yaml` files that the hub auto-discovers, moves container `sync` into the per-machine registry, and enriches `inspect`. **Phase 2** adds a skill-discovery/merge layer (vendored per-type skills ∪ module-local skills from `.okh/skills` and `.claude/skills`), a `run { container, module, skill, input? }` tool, a `custom` module type, and removes the `learn`/`remember`/`reflect` tools. Each phase ends green and committed.

**Tech Stack:** TypeScript (ESM, NodeNext) on `@modelcontextprotocol/sdk`, `zod`, `yaml`; tests with `vitest` running real `git` against temp repos; eval via `promptfoo`.

**Spec:** `docs/superpowers/specs/2026-07-07-okh-module-system-redesign-design.md`

**Verify commands (whole plan):** `npm run typecheck`, `npm test`, `npm run build`; eval: `npm run typecheck:eval`, `npm run test:eval`, `npm run eval:validate`, and full `npm run eval`.

---

## File Structure

**Phase 1 — self-contained modules & discovery**
- Create `src/modules/manifest.ts` — per-module `.okh/module.yaml` schema + read/write/scaffold.
- Create `src/modules/discovery.ts` — scan a container root for module manifests.
- Create `src/container/migrate.ts` — one-time legacy `.okh/okh.yaml` → per-module manifests.
- Modify `src/modules/types.ts` — built-in type list + `isBuiltinType`; `ModuleType` stays the built-in union, module `type` on disk is a string.
- Modify `src/modules/loaders/file-listing.ts` — generalize `kind` to `string` so it can back the custom type.
- Modify `src/modules/registry.ts` — `getLoader(type: string)` returns the built-in loader or a generic file-listing loader for unknown/custom types.
- Modify `src/registry/schema.ts` — add `syncModeSchema` + `sync` field to the container entry.
- Modify `src/container/service.ts` — discovery-driven `status`/`inspect`/`resolveTargets`/`validate`; `sync` from the registry entry; `addContainer` records `sync` + migrates; `addModule` scaffolds a module manifest (with `name`/`description`).
- Modify `src/server/tools.ts` — `add` accepts `name`/`description` and a string `type`; `inspect` output shows module name/description.
- Delete `src/container/manifest.ts`.
- Tests: create `test/module-manifest.test.ts`, `test/discovery.test.ts`, `test/migrate.test.ts`; delete `test/manifest.test.ts`; update `test/service.test.ts`, `test/inspect.test.ts`, `test/integration.test.ts`, `test/sync.test.ts`, `test/registry.test.ts`, `test/helpers.ts`.

**Phase 2 — type skills & generic runner**
- Create `src/modules/skills.ts` — discover + merge skills (vendored ∪ module-local roots), parse standard `SKILL.md`.
- Create vendored skills under `resources/types/<type>/skills/<name>/SKILL.md` (`knowledge/learn`, `memory/remember`, `memory/reflect`).
- Modify `src/prompts/discipline.ts` — add a loader for an arbitrary `SKILL.md` body by absolute path.
- Modify `src/prompts/meta.ts` — keep `ask`/`context`/`onboard`; drop `learn`/`remember`/`reflect`; add `run`.
- Modify `src/prompts/index.ts` — add `buildRun`; remove `buildLearn`/`buildRemember`/`buildReflect`.
- Modify `src/container/service.ts` — `effectiveSkills(container, module)` + `resolveSkill(...)`; `inspect` module view returns the skill set.
- Modify `src/server/tools.ts` — register `run`; remove `learn`/`remember`/`reflect`; enrich module `inspect` with skills.
- Modify eval: `eval/scenarios/{learn,remember,reflect}/*.yaml` → drive `run`; convert `eval/fixtures/*/.okh/okh.yaml` to per-module manifests.
- Tests: create `test/skills.test.ts`, `test/run.test.ts`, `test/custom-module.test.ts`; update `test/prompts.test.ts`, `test/server.test.ts`.

---

# PHASE 1 — Self-contained modules & auto-discovery

### Task 1: Per-module manifest (`src/modules/manifest.ts`)

**Files:**
- Create: `src/modules/manifest.ts`
- Test: `test/module-manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/module-manifest.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadModuleManifest,
  saveModuleManifest,
  moduleManifestExists,
  scaffoldModuleManifest,
  MODULE_OKH_DIR,
  MODULE_MANIFEST_BASENAME,
} from "../src/modules/manifest.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "okh-mm-"));
}

describe("module manifest", () => {
  it("round-trips a valid manifest", async () => {
    const dir = await tmp();
    try {
      await saveModuleManifest(dir, { type: "knowledge", name: "KB", description: "team kb", config: {} });
      expect(await moduleManifestExists(dir)).toBe(true);
      const m = await loadModuleManifest(dir);
      expect(m).toEqual({ type: "knowledge", name: "KB", description: "team kb", config: {} });
      const raw = await readFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "utf8");
      expect(raw).toContain("type: knowledge");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a custom (unknown) type string", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, MODULE_OKH_DIR), { recursive: true });
      await writeFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "type: recipes\nname: Recipes\ndescription: my food\n");
      const m = await loadModuleManifest(dir);
      expect(m.type).toBe("recipes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a manifest missing required fields", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, MODULE_OKH_DIR), { recursive: true });
      await writeFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "type: knowledge\n");
      await expect(loadModuleManifest(dir)).rejects.toThrow(/INVALID_MANIFEST|name/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds a manifest with defaults", () => {
    const m = scaffoldModuleManifest("memory", "notes", "");
    expect(m).toEqual({ type: "memory", name: "notes", description: "" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/module-manifest.test.ts`
Expected: FAIL — cannot find module `../src/modules/manifest.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/modules/manifest.ts
import { mkdir, readFile, writeFile, stat, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { OkhError } from "../errors.js";

export const MODULE_OKH_DIR = ".okh";
export const MODULE_MANIFEST_BASENAME = "module.yaml";

export const moduleManifestSchema = z
  .object({
    type: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(""),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

export function moduleManifestPath(moduleRoot: string): string {
  return join(moduleRoot, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME);
}

export async function moduleManifestExists(moduleRoot: string): Promise<boolean> {
  try {
    await stat(moduleManifestPath(moduleRoot));
    return true;
  } catch {
    return false;
  }
}

export async function loadModuleManifest(moduleRoot: string): Promise<ModuleManifest> {
  const file = moduleManifestPath(moduleRoot);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OkhError("INVALID_MANIFEST", `Module at ${moduleRoot} has no ${MODULE_OKH_DIR}/${MODULE_MANIFEST_BASENAME}.`);
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    throw new OkhError("INVALID_MANIFEST", `${file} is not valid YAML.`);
  }
  const result = moduleManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new OkhError("INVALID_MANIFEST", `${file} does not match the expected schema: ${result.error.message}`);
  }
  return result.data;
}

export async function saveModuleManifest(moduleRoot: string, manifest: ModuleManifest): Promise<void> {
  const validated = moduleManifestSchema.parse(manifest);
  const file = moduleManifestPath(moduleRoot);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, stringifyYaml(validated), "utf8");
  await rename(tmp, file);
}

export function scaffoldModuleManifest(type: string, name: string, description: string): ModuleManifest {
  return { type, name, description };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/module-manifest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/manifest.ts test/module-manifest.test.ts
git commit -m "feat(modules): per-module .okh/module.yaml manifest" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Module discovery scan (`src/modules/discovery.ts`)

**Files:**
- Create: `src/modules/discovery.ts`
- Test: `test/discovery.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/discovery.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModules } from "../src/modules/discovery.js";

async function writeManifest(root: string, rel: string, body: string): Promise<void> {
  await mkdir(join(root, rel, ".okh"), { recursive: true });
  await writeFile(join(root, rel, ".okh", "module.yaml"), body);
}

describe("discoverModules", () => {
  it("finds nested module manifests and returns POSIX paths sorted", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-disc-"));
    try {
      await writeManifest(root, "kb", "type: knowledge\nname: KB\ndescription: d\n");
      await writeManifest(root, join("nested", "mem"), "type: memory\nname: M\ndescription: d\n");
      await mkdir(join(root, ".git"), { recursive: true });
      await writeManifest(root, ".git", "type: knowledge\nname: X\ndescription: d\n"); // must be ignored
      const mods = await discoverModules(root);
      expect(mods.map((m) => m.path)).toEqual(["kb", "nested/mem"]);
      expect(mods[0]!.manifest.type).toBe("knowledge");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not descend into a discovered module", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-disc-"));
    try {
      await writeManifest(root, "outer", "type: custom\nname: O\ndescription: d\n");
      await writeManifest(root, join("outer", "inner"), "type: memory\nname: I\ndescription: d\n");
      const mods = await discoverModules(root);
      expect(mods.map((m) => m.path)).toEqual(["outer"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records an invalid manifest instead of throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-disc-"));
    try {
      await writeManifest(root, "bad", "type: knowledge\n"); // missing name
      const mods = await discoverModules(root);
      expect(mods).toHaveLength(1);
      expect(mods[0]!.error).toMatch(/name/i);
      expect(mods[0]!.manifest).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/discovery.test.ts`
Expected: FAIL — cannot find `../src/modules/discovery.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/modules/discovery.ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  loadModuleManifest,
  moduleManifestExists,
  MODULE_OKH_DIR,
  type ModuleManifest,
} from "./manifest.js";
import { OkhError } from "../errors.js";

export interface DiscoveredModule {
  /** Module path relative to the container root (POSIX separators). */
  path: string;
  /** Parsed manifest, or undefined if it failed to parse. */
  manifest?: ModuleManifest;
  /** Populated when the manifest is present but invalid. */
  error?: string;
}

/**
 * Scan `containerRoot` for modules. A folder is a module iff it contains
 * `.okh/module.yaml`; discovery does not descend below a found module. Skips
 * `.git`. Invalid manifests are recorded (not thrown) so one bad module does
 * not hide the rest.
 */
export async function discoverModules(containerRoot: string): Promise<DiscoveredModule[]> {
  const out: DiscoveredModule[] = [];

  async function recurse(rel: string): Promise<void> {
    const abs = rel ? join(containerRoot, rel) : containerRoot;
    if (rel && (await moduleManifestExists(abs))) {
      try {
        out.push({ path: rel, manifest: await loadModuleManifest(abs) });
      } catch (err) {
        out.push({ path: rel, error: err instanceof OkhError ? err.message : String(err) });
      }
      return; // do not descend into a discovered module
    }
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === ".git" || e.name === MODULE_OKH_DIR) continue;
      await recurse(rel ? `${rel}/${e.name}` : e.name);
    }
  }

  await recurse("");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/discovery.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/discovery.ts test/discovery.test.ts
git commit -m "feat(modules): auto-discover modules by scanning for .okh/module.yaml" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Type registry with custom fallback

**Files:**
- Modify: `src/modules/types.ts`
- Modify: `src/modules/loaders/file-listing.ts:16`
- Modify: `src/modules/registry.ts`
- Test: `test/loaders.test.ts` (add a case)

- [ ] **Step 1: Write the failing test** (append to `test/loaders.test.ts`)

```ts
// test/loaders.test.ts — add
import { getLoader } from "../src/modules/registry.js";
import { isBuiltinType, BUILTIN_MODULE_TYPES } from "../src/modules/types.js";

describe("type registry", () => {
  it("recognises built-in types", () => {
    expect(isBuiltinType("knowledge")).toBe(true);
    expect(isBuiltinType("recipes")).toBe(false);
    expect(BUILTIN_MODULE_TYPES).toContain("memory");
  });

  it("falls back to a file-listing loader for a custom type", async () => {
    const loader = getLoader("recipes");
    const overview = await loader.overview("/does/not/exist");
    expect(typeof overview).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/loaders.test.ts`
Expected: FAIL — `isBuiltinType`/`BUILTIN_MODULE_TYPES` not exported; `getLoader("recipes")` type error.

- [ ] **Step 3: Update `src/modules/types.ts`**

Replace lines 3-6 with:

```ts
/** The five built-in module types. Order is not significant. */
export const BUILTIN_MODULE_TYPES = ["knowledge", "skills", "tools", "memory", "project"] as const;
export const moduleTypeSchema = z.enum(BUILTIN_MODULE_TYPES);
export type ModuleType = (typeof BUILTIN_MODULE_TYPES)[number];

/** A module's on-disk `type` is any non-empty string; unknown => custom. */
export function isBuiltinType(type: string): type is ModuleType {
  return (BUILTIN_MODULE_TYPES as readonly string[]).includes(type);
}
```

(Keep the `Item` and `Loader` interfaces unchanged. Retain a `MODULE_TYPES` alias export `export const MODULE_TYPES = BUILTIN_MODULE_TYPES;` if other files import it — grep first: `grep -rn "MODULE_TYPES" src test`.)

- [ ] **Step 4: Generalise `file-listing.ts`**

Change the signature at `src/modules/loaders/file-listing.ts:16`:

```ts
export function fileListingLoader(kind: string, heading: string): Loader {
```

- [ ] **Step 5: Update `src/modules/registry.ts`**

```ts
import type { Loader, ModuleType } from "./types.js";
import { isBuiltinType } from "./types.js";
import { knowledgeLoader } from "./loaders/knowledge.js";
import { skillsLoader } from "./loaders/skills.js";
import { toolsLoader } from "./loaders/tools.js";
import { memoryLoader } from "./loaders/memory.js";
import { projectLoader } from "./loaders/project.js";
import { fileListingLoader } from "./loaders/file-listing.js";

const LOADERS: Record<ModuleType, Loader> = {
  knowledge: knowledgeLoader,
  skills: skillsLoader,
  tools: toolsLoader,
  memory: memoryLoader,
  project: projectLoader,
};

const customLoader = fileListingLoader("custom", "Module");

/** Resolve a loader by type. Unknown/custom types use a generic file-listing loader. */
export function getLoader(type: string): Loader {
  return isBuiltinType(type) ? LOADERS[type] : customLoader;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/loaders.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/types.ts src/modules/registry.ts src/modules/loaders/file-listing.ts test/loaders.test.ts
git commit -m "feat(modules): custom type falls back to a file-listing loader" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Container entry gains `sync`

**Files:**
- Modify: `src/registry/schema.ts`
- Test: `test/registry.test.ts` (add a case)

- [ ] **Step 1: Write the failing test** (append to `test/registry.test.ts`)

```ts
// test/registry.test.ts — add
import { containerEntrySchema } from "../src/registry/schema.js";

describe("container entry sync", () => {
  it("defaults sync to auto", () => {
    const e = containerEntrySchema.parse({
      name: "h", backend: "local", localPath: "/x", addedAt: new Date().toISOString(),
    });
    expect(e.sync).toBe("auto");
  });
  it("accepts pr", () => {
    const e = containerEntrySchema.parse({
      name: "h", backend: "local", localPath: "/x", addedAt: new Date().toISOString(), sync: "pr",
    });
    expect(e.sync).toBe("pr");
  });
  it("rejects an unknown sync value", () => {
    expect(() => containerEntrySchema.parse({
      name: "h", backend: "local", localPath: "/x", addedAt: new Date().toISOString(), sync: "nope",
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry.test.ts`
Expected: FAIL — `sync` is stripped/rejected by the strict schema.

- [ ] **Step 3: Update `src/registry/schema.ts`**

Add after `backendSchema` (line ~30):

```ts
export const syncModeSchema = z.enum(["auto", "pr"]);
export type SyncMode = z.infer<typeof syncModeSchema>;
```

Add `sync` to `containerEntrySchema` (inside the object, before `addedAt`):

```ts
    sync: syncModeSchema.default("auto"),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/registry/schema.ts test/registry.test.ts
git commit -m "feat(registry): record container sync mode on the registry entry" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Legacy manifest migration (`src/container/migrate.ts`)

**Files:**
- Create: `src/container/migrate.ts`
- Test: `test/migrate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/migrate.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyContainerManifest } from "../src/container/migrate.js";
import { loadModuleManifest } from "../src/modules/manifest.js";

describe("migrateLegacyContainerManifest", () => {
  it("writes per-module manifests, returns sync, deletes the legacy file", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-mig-"));
    try {
      await mkdir(join(root, ".okh"), { recursive: true });
      await mkdir(join(root, "kb"), { recursive: true });
      await writeFile(join(root, ".okh", "okh.yaml"),
        "name: h\nsync: pr\nmodules:\n  - path: kb\n    type: knowledge\n");
      const sync = await migrateLegacyContainerManifest(root);
      expect(sync).toBe("pr");
      const m = await loadModuleManifest(join(root, "kb"));
      expect(m.type).toBe("knowledge");
      expect(m.name).toBe("kb");
      await expect(stat(join(root, ".okh", "okh.yaml"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is a no-op when there is no legacy manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-mig-"));
    try {
      expect(await migrateLegacyContainerManifest(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/migrate.test.ts`
Expected: FAIL — cannot find `../src/container/migrate.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/container/migrate.ts
import { readFile, rm, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { saveModuleManifest, moduleManifestExists } from "../modules/manifest.js";
import { syncModeSchema, type SyncMode } from "../registry/schema.js";

const LEGACY_REL = join(".okh", "okh.yaml");

const legacySchema = z.object({
  sync: syncModeSchema.optional(),
  modules: z
    .array(z.object({ path: z.string(), type: z.string(), config: z.record(z.string(), z.unknown()).optional() }))
    .default([]),
});

/**
 * One-time migration: if `<root>/.okh/okh.yaml` exists, write a per-module
 * `<module>/.okh/module.yaml` for each listed module (unless one already exists),
 * delete the legacy file, and return its `sync` mode. Idempotent: no-op when the
 * legacy file is absent.
 */
export async function migrateLegacyContainerManifest(root: string): Promise<SyncMode | undefined> {
  const legacyPath = join(root, LEGACY_REL);
  let raw: string;
  try {
    raw = await readFile(legacyPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed = legacySchema.safeParse(parseYaml(raw));
  if (!parsed.success) return undefined; // leave a malformed legacy file alone
  for (const m of parsed.data.modules) {
    const moduleRoot = join(root, m.path);
    if ((await stat(moduleRoot).catch(() => null)) && !(await moduleManifestExists(moduleRoot))) {
      await saveModuleManifest(moduleRoot, {
        type: m.type,
        name: basename(m.path),
        description: "",
        ...(m.config ? { config: m.config } : {}),
      });
    }
  }
  await rm(legacyPath, { force: true });
  return parsed.data.sync;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/migrate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/container/migrate.ts test/migrate.test.ts
git commit -m "feat(container): migrate legacy .okh/okh.yaml to per-module manifests" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Rewire ContainerService onto discovery (read paths)

**Files:**
- Modify: `src/container/service.ts` (imports; `status`, `validate`, `inspect`, `resolveTargets`; type shapes)
- Test: `test/service.test.ts`, `test/inspect.test.ts` (update expectations)

This task replaces every container-manifest read with discovery. Do it in one pass, then fix the two test files.

- [ ] **Step 1: Update imports at the top of `src/container/service.ts`**

Remove the `./manifest.js` import block (lines 23-32) and the `getLoader` type usage stays. Add:

```ts
import { discoverModules, type DiscoveredModule } from "../modules/discovery.js";
import { migrateLegacyContainerManifest } from "./migrate.js";
import { loadModuleManifest, saveModuleManifest, moduleManifestExists, moduleManifestPath, type ModuleManifest } from "../modules/manifest.js";
import { isBuiltinType } from "../modules/types.js";
import { type SyncMode } from "../registry/schema.js";
```

Delete the `ContainerManifest`/`ModuleEntry`/`modulePathSchema` imports. Keep `moduleTypeSchema` import removed unless still used (`addModule` now accepts a string type — see Task 7).

- [ ] **Step 2: Update the exported type shapes**

`ModuleStatus`, `ResolvedModule`, and the `module` field of `InspectResult` gain `name`/`description`; `type` becomes `string`:

```ts
export interface ModuleStatus {
  path: string;
  type: string;
  name: string;
  description: string;
  items: number;
}
export interface ResolvedModule {
  type: string;
  path: string;
  name: string;
  description: string;
  absPath: string;
}
```

In `InspectResult`, change the `module` case to:

```ts
  | {
      kind: "module";
      module: { path: string; type: string; name: string; description: string; config?: Record<string, unknown> };
      items: Item[];
    };
```

Change `ContainerStatus.sync` type to `SyncMode` (from the entry), and keep `manifestValid`/`manifestError` (now meaning "all discovered module manifests parsed").

- [ ] **Step 3: Rewrite `status()`**

```ts
async status(name: string): Promise<ContainerStatus> {
  const reg = await loadRegistry(this.paths);
  const entry = requireContainer(reg, name);
  const root = entry.localPath;

  await migrateLegacyContainerManifest(root).catch(() => undefined);
  const discovered = await discoverModules(root);
  const invalid = discovered.filter((d) => d.error);
  const modules: ModuleStatus[] = await Promise.all(
    discovered
      .filter((d): d is DiscoveredModule & { manifest: ModuleManifest } => !!d.manifest)
      .map(async (d) => ({
        path: d.path,
        type: d.manifest.type,
        name: d.manifest.name,
        description: d.manifest.description,
        items: (await this.safeEnumerate(d.manifest.type, this.moduleRoot(root, d.path))).length,
      })),
  );

  let git: GitStatus | undefined;
  if (entry.backend === "git") {
    const [branch, dirty, ab, unpushed] = await Promise.all([
      this.git.currentBranch(root), this.git.isDirty(root),
      this.git.aheadBehind(root), this.git.hasUnpushedCommits(root),
    ]);
    git = { branch, dirty, ahead: ab?.ahead ?? 0, behind: ab?.behind ?? 0, hasUnpushedCommits: unpushed };
  }

  return {
    name, backend: entry.backend, sync: entry.sync, localPath: root,
    manifestValid: invalid.length === 0,
    ...(invalid.length ? { manifestError: invalid.map((d) => `${d.path}: ${d.error}`).join("; ") } : {}),
    modules, git,
  };
}
```

Change `safeEnumerate(type: ModuleType, ...)` to `safeEnumerate(type: string, ...)`.

- [ ] **Step 4: Rewrite `validate()`**

```ts
async validate(name: string): Promise<{ ok: boolean; issues: string[] }> {
  const reg = await loadRegistry(this.paths);
  const entry = requireContainer(reg, name);
  const root = entry.localPath;
  await migrateLegacyContainerManifest(root).catch(() => undefined);
  const discovered = await discoverModules(root);
  const issues: string[] = [];
  for (const d of discovered) {
    if (d.error) { issues.push(`module "${d.path}": ${d.error}`); continue; }
    const m = d.manifest!;
    if (m.type === "knowledge") {
      const idx = await stat(join(this.moduleRoot(root, d.path), "index.md")).catch(() => null);
      if (!idx) issues.push(`knowledge module "${d.path}": missing index.md`);
    }
  }
  return { ok: issues.length === 0, issues };
}
```

- [ ] **Step 5: Rewrite `inspect()` (container-list + module views)**

Container-list branch (`!container`) — replace `st?.sync` etc. with entry `sync` and `st?.manifestValid`:

```ts
if (!container) {
  const containers = await Promise.all(
    reg.containers.map(async (c) => {
      const st = await this.status(c.name).catch(() => undefined);
      return {
        name: c.name, backend: c.backend, sync: c.sync,
        moduleCount: st?.modules.length ?? 0,
        manifestValid: st?.manifestValid ?? false,
        localPath: c.localPath,
      };
    }),
  );
  return { kind: "containers", containers };
}
```

Module view (`container` + `module`) — replace the manifest lookup:

```ts
const entry = requireContainer(reg, container);
if (!module) return { kind: "container", status: await this.status(container) };

await migrateLegacyContainerManifest(entry.localPath).catch(() => undefined);
const moduleRoot = this.moduleRoot(entry.localPath, module);
if (!(await moduleManifestExists(moduleRoot))) {
  throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
}
const manifest = await loadModuleManifest(moduleRoot);
const items = await this.safeEnumerate(manifest.type, moduleRoot);
return {
  kind: "module",
  module: { path: module, type: manifest.type, name: manifest.name, description: manifest.description, ...(manifest.config ? { config: manifest.config } : {}) },
  items,
};
```

(`InspectResult.containers[].sync` type becomes `SyncMode`.)

- [ ] **Step 6: Rewrite `resolveTargets()`**

```ts
async resolveTargets(container?: string, module?: string): Promise<ResolvedContainer[]> {
  const reg = await loadRegistry(this.paths);
  const entries = container ? [requireContainer(reg, container)] : reg.containers;
  const out: ResolvedContainer[] = [];
  for (const entry of entries) {
    await migrateLegacyContainerManifest(entry.localPath).catch(() => undefined);
    let discovered = (await discoverModules(entry.localPath)).filter((d) => d.manifest);
    if (module) discovered = discovered.filter((d) => d.path === module);
    if (container && module && discovered.length === 0) {
      throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
    }
    out.push({
      name: entry.name, backend: entry.backend, sync: entry.sync, root: entry.localPath,
      modules: discovered.map((d) => ({
        type: d.manifest!.type, path: d.path, name: d.manifest!.name,
        description: d.manifest!.description, absPath: this.moduleRoot(entry.localPath, d.path),
      })),
    });
  }
  return out;
}
```

Update `ResolvedContainer.sync` type to `SyncMode`.

- [ ] **Step 7: Update `test/service.test.ts` and `test/inspect.test.ts`**

Wherever tests build a container fixture by writing `.okh/okh.yaml`, switch to writing per-module manifests (use `saveModuleManifest`) or the shared helper (Task 9 updates `test/helpers.ts`). Update assertions to expect `name`/`description` on modules and `sync` sourced from the registry entry. Run each file and fix expectations until green.

- [ ] **Step 8: Run the read-path tests**

Run: `npx vitest run test/service.test.ts test/inspect.test.ts test/discovery.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/container/service.ts test/service.test.ts test/inspect.test.ts
git commit -m "feat(container): drive status/inspect/resolveTargets/validate from module discovery" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Rewire ContainerService add-paths + sync

**Files:**
- Modify: `src/container/service.ts` (`AddContainer*`, `AddModule*`, `addContainer`, `addModule`, `syncOne`)
- Test: `test/add-confirm.test.ts`, `test/sync.test.ts`

- [ ] **Step 1: Update `AddModuleInput`/`AddModulePlan` for name/description + string type**

```ts
export interface AddModuleInput {
  container: string;
  path: string;
  type: string;
  name: string;
  description?: string;
  config?: Record<string, unknown>;
  create?: boolean;
}
export interface AddModulePlan {
  kind: "module";
  actions: ModuleAction[];
  container: string;
  path: string;
  type: string;
  name: string;
  description: string;
  moduleRoot: string;
  config?: Record<string, unknown>;
}
export type AddModuleOutcome =
  | { kind: "plan"; plan: AddModulePlan }
  | { kind: "applied"; entry: { path: string; type: string; name: string }; moduleRoot: string };
```

`ModuleAction` drops `init-manifest`: `export type ModuleAction = "create-folder" | "scaffold";`

- [ ] **Step 2: Rewrite `planAddContainer` sync handling**

`sync` is no longer written into a container manifest — it is recorded on the registry entry. Drop the `init-manifest` action and the `manifestExists`/`loadContainerManifest` checks. Keep `sync`/`syncExplicit` on the plan (used to set the entry). For a git clone the actions stay `["clone"]`; for a path, actions are `["create-folder"]` only when the folder is absent (else `[]`).

```ts
async planAddContainer(input: AddContainerInput): Promise<AddContainerPlan> {
  const isGit = looksLikeGitUrl(input.source);
  const name = validate(containerNameSchema, input.name ?? deriveName(input.source), "name");
  const reg = await loadRegistry(this.paths);
  if (findContainer(reg, name)) throw new OkhError("ALREADY_EXISTS", `A container named "${name}" already exists.`);
  const sync: SyncMode = input.sync ?? "auto";
  const syncExplicit = input.sync !== undefined;
  if (isGit) {
    validate(repoUrlSchema, input.source, "source");
    return { kind: "container", actions: ["clone"], name, backend: "git", source: input.source, target: containerCloneDir(this.paths, name), sync, syncExplicit };
  }
  const backend: Backend = input.backend ?? "local";
  const target = resolve(input.source);
  const s = await stat(target).catch(() => null);
  if (s && !s.isDirectory()) throw new OkhError("INVALID_ARGUMENT", `Path "${input.source}" exists but is not a directory.`);
  const actions: ContainerAction[] = s ? [] : ["create-folder"];
  return { kind: "container", actions, name, backend, source: input.source, target, sync, syncExplicit };
}
```

`ContainerAction` drops `init-manifest`: `export type ContainerAction = "create-folder" | "clone";`

- [ ] **Step 3: `addContainerImpl` must apply even when actions is empty**

Since a path container that already exists now yields `actions: []`, gate on `create` only:

```ts
private async addContainerImpl(input: AddContainerInput): Promise<AddContainerOutcome> {
  const plan = await this.planAddContainer(input);
  if (!input.create) return { kind: "plan", plan };
  return { kind: "applied", entry: await this.applyAddContainer(plan) };
}
```

- [ ] **Step 4: Rewrite `applyAddContainer` to migrate + store sync on the entry (no container manifest)**

```ts
private async applyAddContainer(plan: AddContainerPlan): Promise<ContainerEntry> {
  const reg = await loadRegistry(this.paths);
  if (findContainer(reg, plan.name)) throw new OkhError("ALREADY_EXISTS", `A container named "${plan.name}" already exists.`);
  let origin: string | undefined;
  if (plan.backend === "git") {
    origin = plan.source;
    await this.assertDirAvailable(plan.target);
    await mkdir(this.paths.containersDir, { recursive: true });
    try { await this.git.clone(plan.source, plan.target); }
    catch (err) { await rm(plan.target, { recursive: true, force: true }); throw err; }
  } else {
    await mkdir(plan.target, { recursive: true });
  }
  const migratedSync = await migrateLegacyContainerManifest(plan.target).catch(() => undefined);
  const sync: SyncMode = plan.syncExplicit ? plan.sync : (migratedSync ?? plan.sync);
  const entry: ContainerEntry = {
    name: plan.name, backend: plan.backend, ...(origin ? { origin } : {}),
    localPath: plan.target, sync, addedAt: new Date().toISOString(),
  };
  await saveRegistry(this.paths, withContainerAdded(reg, entry));
  return entry;
}
```

- [ ] **Step 5: Rewrite `planAddModule`/`applyAddModule` to scaffold a module manifest**

```ts
async planAddModule(input: AddModuleInput): Promise<AddModulePlan> {
  validate(modulePathString, input.path, "module path"); // see note below
  const reg = await loadRegistry(this.paths);
  const container = requireContainer(reg, input.container);
  const root = container.localPath;
  const moduleRoot = this.moduleRoot(root, input.path);
  if (await moduleManifestExists(moduleRoot)) {
    throw new OkhError("ALREADY_EXISTS", `Module path "${input.path}" already exists in container "${input.container}".`);
  }
  const actions: ModuleAction[] = [];
  const modDir = await stat(moduleRoot).then((x) => x.isDirectory()).catch(() => false);
  if (!modDir) actions.push("create-folder");
  if (getLoader(input.type).scaffold) actions.push("scaffold");
  return {
    kind: "module", actions, container: input.container, path: input.path, type: input.type,
    name: input.name, description: input.description ?? "", moduleRoot,
    ...(input.config ? { config: input.config } : {}),
  };
}

private async applyAddModule(plan: AddModulePlan): Promise<{ entry: { path: string; type: string; name: string }; moduleRoot: string }> {
  await mkdir(plan.moduleRoot, { recursive: true });
  const loader = getLoader(plan.type);
  if (loader.scaffold) {
    try { await loader.scaffold(plan.moduleRoot); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  }
  await saveModuleManifest(plan.moduleRoot, {
    type: plan.type, name: plan.name, description: plan.description,
    ...(plan.config ? { config: plan.config } : {}),
  });
  return { entry: { path: plan.path, type: plan.type, name: plan.name }, moduleRoot: plan.moduleRoot };
}
```

Note: replace the old `modulePathSchema` (from the deleted `container/manifest.ts`) with a local guard. Add near the top of `service.ts`:

```ts
import { isAbsolute as pathIsAbsolute, normalize as pathNormalize } from "node:path";
const modulePathString = z
  .string().min(1)
  .refine((s) => !pathIsAbsolute(s), "module path must be relative")
  .refine((s) => {
    const n = pathNormalize(s).replace(/\\/g, "/");
    return n !== ".." && !n.startsWith("../") && !n.split("/").includes("..");
  }, "module path must not contain '..' segments");
```

(Import `z` from `zod` in `service.ts`.) Remove `loadOrScaffold`/`loadManifestOrEmpty` (container-manifest helpers) — they are now unused.

- [ ] **Step 6: `addModuleImpl` gates on create only**

```ts
private async addModuleImpl(input: AddModuleInput): Promise<AddModuleOutcome> {
  const plan = await this.planAddModule(input);
  if (!input.create) return { kind: "plan", plan };
  return { kind: "applied", ...(await this.applyAddModule(plan)) };
}
```

- [ ] **Step 7: `syncOne` reads sync from the entry**

Replace the container-manifest read:

```ts
private async syncOne(entry: ContainerEntry, message?: string): Promise<SyncResult> {
  const validation = await this.validate(entry.name);
  if (entry.backend !== "git") {
    return { name: entry.name, backend: entry.backend, validation, action: "validated" };
  }
  return entry.sync === "pr"
    ? this.syncPr(entry, validation, message)
    : this.syncAuto(entry, validation, message);
}
```

- [ ] **Step 8: Update `test/add-confirm.test.ts` and `test/sync.test.ts`**

`add` for a module now requires `name`; plans no longer include `init-manifest`. `add` for an existing path folder now applies with `actions: []`. Update fixtures to per-module manifests and set `sync` via the registry entry / `add { sync }`. Fix assertions to green.

- [ ] **Step 9: Run the add/sync tests**

Run: `npx vitest run test/add-confirm.test.ts test/sync.test.ts test/service.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/container/service.ts test/add-confirm.test.ts test/sync.test.ts
git commit -m "feat(container): add/sync use per-module manifests + registry sync" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Tools — enriched `inspect`, module `add` fields, string type

**Files:**
- Modify: `src/server/tools.ts` (`formatInspect`, `formatModulePlan`, `add` inputSchema/handler)
- Test: `test/server.test.ts` (update)

- [ ] **Step 1: Update `formatInspect` module + container-list rendering**

Container view module line and module view items now include name/description. Replace the relevant lines:

```ts
// container view — modules
...(s.modules.length
  ? s.modules.map((m) => `  - ${m.type} · ${m.name}${m.description ? ` — ${m.description}` : ""}: ${m.path} (${m.items} items)`)
  : ["  (none)"]),
```

```ts
// module view head
const head = `Module ${r.module.path} [${r.module.type}] ${r.module.name}${r.module.description ? ` — ${r.module.description}` : ""} — ${r.items.length} items`;
```

- [ ] **Step 2: Update `add` inputSchema** (in `registerTools`)

Replace `type: moduleTypeSchema.optional()...` with a string type, and add `name`/`description`:

```ts
type: z.string().min(1).optional().describe("Module type: a built-in (knowledge, skills, tools, memory, project) or a custom type name (new module)."),
name: z.string().optional().describe("Module display name (new module)."),
description: z.string().optional().describe("One-line module description (new module)."),
```

Update the handler's arg type (`type?: string`) and the `hasModuleFields`/`addModule` call to pass `name`/`description`. Require `name` when adding a module:

```ts
if (args.container === undefined || args.path === undefined || args.type === undefined || args.name === undefined) {
  return fail("Adding a module requires { container, path, type, name }.");
}
...
const outcome = await service.addModule({
  container: args.container, path: args.path, type: args.type, name: args.name,
  ...(args.description !== undefined ? { description: args.description } : {}),
  ...(args.config ? { config: args.config } : {}),
  ...(args.create ? { create: true } : {}),
});
```

Also add `name` to `hasModuleFields` detection and update `formatModulePlan` to show `name`. Remove the now-unused `moduleTypeSchema` import if nothing else needs it (keep it if `add`'s container branch still references it — it doesn't).

- [ ] **Step 3: Update `test/server.test.ts`**

Any `add` module call must now include `name`. Inspect-output assertions must include the name/description. Fix to green.

- [ ] **Step 4: Run the server tests**

Run: `npx vitest run test/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tools.ts test/server.test.ts
git commit -m "feat(tools): add module name/description + custom type; inspect surfaces them" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: Delete the container manifest + fixtures/helpers cleanup, full green

**Files:**
- Delete: `src/container/manifest.ts`, `test/manifest.test.ts`
- Modify: `test/helpers.ts`, `test/integration.test.ts`, `test/prompts.test.ts`, and any remaining `.okh/okh.yaml` fixtures under `test/`

- [ ] **Step 1: Grep for remaining container-manifest references**

Run: `grep -rn "container/manifest\|loadContainerManifest\|saveContainerManifest\|okh.yaml\|ContainerManifest\|scaffoldManifest\|modulePathSchema" src test`
Expected: only hits are the files below; there must be **no** remaining `src/` import of `container/manifest.js`.

- [ ] **Step 2: Update `test/helpers.ts`**

If helpers build a container by writing `.okh/okh.yaml`, replace with a helper that writes per-module manifests, e.g.:

```ts
import { saveModuleManifest } from "../src/modules/manifest.js";
export async function writeModule(containerRoot: string, path: string, type: string, name = path, description = ""): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(join(containerRoot, path), { recursive: true });
  await saveModuleManifest(join(containerRoot, path), { type, name, description });
}
```

Update the registry-entry helper to include `sync: "auto"`.

- [ ] **Step 3: Delete the container manifest + its test**

```bash
git rm src/container/manifest.ts test/manifest.test.ts
```

- [ ] **Step 4: Fix `test/integration.test.ts` and `test/prompts.test.ts`**

Rebuild fixtures via `writeModule`; set container `sync` via the registry entry / `add { sync }`. In `prompts.test.ts`, `resolveTargets` output now carries `name`/`description` on modules — update snapshot/expectations. (Note: `learn`/`remember`/`reflect` prompt builders still exist in Phase 1 and remain covered here; they are removed in Phase 2.)

- [ ] **Step 5: Full typecheck + tests + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; all tests PASS; build emits `dist/`.

- [ ] **Step 6: Commit the Phase 1 checkpoint**

```bash
git add -A
git commit -m "refactor(container): remove container manifest; modules are self-describing" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

> **Checkpoint:** Phase 1 is a working, testable milestone — containers are folders of self-describing modules; the existing flows still operate. Safe to pause/review here.

---

# PHASE 2 — Type skills & generic runner

### Task 10: Skill discovery + merge (`src/modules/skills.ts`)

**Files:**
- Create: `src/modules/skills.ts`
- Test: `test/skills.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/skills.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModuleSkills, mergeSkills, MODULE_SKILL_ROOTS, type Skill } from "../src/modules/skills.js";

async function skill(root: string, rel: string, name: string, description: string, body = "do it"): Promise<void> {
  await mkdir(join(root, rel), { recursive: true });
  await writeFile(join(root, rel, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

describe("module skills", () => {
  it("discovers skills from .okh/skills and .claude/skills", async () => {
    const mod = await mkdtemp(join(tmpdir(), "okh-sk-"));
    try {
      await skill(mod, join(".okh", "skills", "remember"), "remember", "record a note");
      await skill(mod, join(".claude", "skills", "summarize"), "summarize", "summarize pages");
      const skills = await discoverModuleSkills(mod);
      expect(skills.map((s) => s.name).sort()).toEqual(["remember", "summarize"]);
      expect(skills.find((s) => s.name === "remember")!.body).toContain("do it");
      expect(MODULE_SKILL_ROOTS).toContain(".claude/skills");
    } finally {
      await rm(mod, { recursive: true, force: true });
    }
  });

  it("module-local skills override vendored by name", () => {
    const vendored: Skill[] = [{ name: "learn", description: "vendored", body: "V", source: "vendored" }];
    const local: Skill[] = [{ name: "learn", description: "local", body: "L", source: ".okh/skills" }];
    const merged = mergeSkills(vendored, local);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.body).toBe("L");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/skills.test.ts`
Expected: FAIL — cannot find `../src/modules/skills.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/modules/skills.ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter, stringField } from "../util/frontmatter.js";

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** Provenance label for inspect/debugging. */
  source: string;
}

/** Module-local skill roots scanned, in precedence order (later roots do not override earlier by design; merge handles override). */
export const MODULE_SKILL_ROOTS = [".okh/skills", ".claude/skills"] as const;

async function subdirNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Read one `<dir>/SKILL.md` into a Skill, or undefined if absent/unnamed. */
export async function readSkill(dir: string, source: string): Promise<Skill | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
  const { data, body } = parseFrontmatter(text);
  const name = stringField(data, "name");
  if (!name) return undefined;
  return { name, description: stringField(data, "description") ?? "", body: body.trim(), source };
}

/** Discover module-local skills across all known skill roots inside a module. */
export async function discoverModuleSkills(moduleRoot: string): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const root of MODULE_SKILL_ROOTS) {
    const base = join(moduleRoot, root);
    for (const name of await subdirNames(base)) {
      const s = await readSkill(join(base, name), root);
      if (s) out.push(s);
    }
  }
  return out;
}

/** Discover vendored skills for a built-in type from an absolute vendored dir. */
export async function discoverVendoredSkills(vendoredDir: string): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const name of await subdirNames(vendoredDir)) {
    const s = await readSkill(join(vendoredDir, name), "vendored");
    if (s) out.push(s);
  }
  return out;
}

/** Merge vendored ∪ local; a local skill overrides a vendored one of the same name. */
export function mergeSkills(vendored: Skill[], local: Skill[]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of vendored) byName.set(s.name, s);
  for (const s of local) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/skills.ts test/skills.test.ts
git commit -m "feat(modules): discover + merge module skills (.okh/skills, .claude/skills, vendored)" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 11: Vendored per-type skills + registry mapping

**Files:**
- Create: `resources/types/knowledge/skills/learn/SKILL.md`
- Create: `resources/types/memory/skills/remember/SKILL.md`
- Create: `resources/types/memory/skills/reflect/SKILL.md`
- Create: `src/modules/vendored.ts` — resolve a type's vendored skills dir + list vendored skills
- Test: `test/skills.test.ts` (add a vendored-dir case)

- [ ] **Step 1: Author `resources/types/knowledge/skills/learn/SKILL.md`**

```markdown
---
name: learn
description: Integrate new knowledge into this knowledge (OKF) module — only if it earns its place against the module's goals and scope.
---

Fold the candidate knowledge into this `knowledge` module following the OKF learn gate
(default answer "no" unless it serves a goal) and the OKF writer discipline.

1. Load the module's `index.md` scope contract (goals, target questions, out-of-scope) and restate it.
2. Gate the candidate: admit only if it serves a goal / answers a target question; otherwise reject with a goal-based reason, or iterate with the user on an explicit scope change.
3. Verify & ground every admitted claim (cite the repo's git origin URL pinned to a SHA, attribute to the user, or flag ⚠️ UNVERIFIED).
4. Prefer extending an existing concept over adding a new doc; update `index.md` and `log.md`.
5. Re-test the gate and prune anything made redundant.
```

- [ ] **Step 2: Author `resources/types/memory/skills/remember/SKILL.md`** (port `resources/discipline/remember.md` body)

```markdown
---
name: remember
description: Record a raw observation, event, or result into this memory module.
---

Record a raw observation, event, or result. Keep it factual and small. The memory format is provisional (TBD); until it is finalized:

1. Append a single dated entry to a markdown file in this memory module (e.g. `YYYY-MM-DD.md`), newest entries at the bottom.
2. Each entry: an ISO timestamp, a one-line summary, then the raw observation. Include concrete references (paths, commands, outcomes).
3. Do NOT synthesize or draw conclusions — that is `reflect`'s job. Record what happened, not what it means.

Keep entries append-only; never rewrite history.
```

- [ ] **Step 3: Author `resources/types/memory/skills/reflect/SKILL.md`** (port `resources/discipline/reflect.md` body)

```markdown
---
name: reflect
description: Turn accumulated memory and experience in this module into durable insight and proposed updates.
---

Turn accumulated memory and experience into durable insight.

1. Read this memory module and any focus the caller gave.
2. Identify patterns, lessons, recurring problems, and improvements.
3. Produce a short summary of what was learned, concrete lessons, and proposed changes. Cite the memory entries that support each lesson.
4. Where a lesson is durable knowledge, fold it into a `knowledge` module using its `learn` skill.
5. Annotate memory that is now superseded (append a note; do not delete raw history).

Prefer a few high-signal insights over an exhaustive recap.
```

- [ ] **Step 4: Write `src/modules/vendored.ts`**

```ts
// src/modules/vendored.ts
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";
import { discoverVendoredSkills, type Skill } from "./skills.js";
import { isBuiltinType } from "./types.js";

// resources/ sits at the package root; ../../ resolves there from src (tsx) and dist (built).
const TYPES_ROOT = new URL("../../resources/types/", import.meta.url);

/** Absolute path to a type's vendored skills dir, or undefined for custom types. */
export function vendoredSkillsDir(type: string): string | undefined {
  if (!isBuiltinType(type)) return undefined;
  return fileURLToPath(new URL(`${type}/skills/`, TYPES_ROOT));
}

/** List a type's vendored skills (empty for custom types or types with no skills). */
export async function vendoredSkills(type: string): Promise<Skill[]> {
  const dir = vendoredSkillsDir(type);
  if (!dir) return [];
  if (!(await stat(dir).then((s) => s.isDirectory()).catch(() => false))) return [];
  return discoverVendoredSkills(dir);
}
```

- [ ] **Step 5: Add a vendored-dir test** (append to `test/skills.test.ts`)

```ts
import { vendoredSkills } from "../src/modules/vendored.js";
describe("vendored skills", () => {
  it("lists knowledge and memory vendored skills", async () => {
    expect((await vendoredSkills("knowledge")).map((s) => s.name)).toContain("learn");
    expect((await vendoredSkills("memory")).map((s) => s.name).sort()).toEqual(["reflect", "remember"]);
    expect(await vendoredSkills("recipes")).toEqual([]);
  });
});
```

- [ ] **Step 6: Run tests + verify resources are packaged**

Run: `npx vitest run test/skills.test.ts`
Expected: PASS.
Check `package.json` `files` includes `resources` (it already ships `resources/`); if a build copies resources, confirm `resources/types/**` is included.

- [ ] **Step 7: Commit**

```bash
git add resources/types src/modules/vendored.ts test/skills.test.ts
git commit -m "feat(skills): vendored per-type learn/remember/reflect skills" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 12: Service — `effectiveSkills` + `resolveSkill`; inspect lists skills

**Files:**
- Modify: `src/container/service.ts`
- Test: `test/run.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/run.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { resolvePaths } from "../src/config.js";
import { saveModuleManifest } from "../src/modules/manifest.js";
import { saveRegistry } from "../src/registry/registry.js";

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "okh-home-"));
  const root = await mkdtemp(join(tmpdir(), "okh-c-"));
  const paths = resolvePaths({ OKH_HOME: home });
  await saveRegistry(paths, { version: 1, containers: [{ name: "h", backend: "local", localPath: root, sync: "auto", addedAt: new Date().toISOString() }] });
  return { home, root, paths, svc: new ContainerService(paths) };
}

describe("effective skills + resolveSkill", () => {
  it("merges vendored memory skills with module-local skills", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "mem"), { type: "memory", name: "Mem", description: "" });
    await mkdir(join(root, "mem", ".okh", "skills", "purge"), { recursive: true });
    await writeFile(join(root, "mem", ".okh", "skills", "purge", "SKILL.md"), "---\nname: purge\ndescription: drop old notes\n---\n\nPurge.\n");
    const skills = await svc.effectiveSkills("h", "mem");
    expect(skills.map((s) => s.name).sort()).toEqual(["purge", "reflect", "remember"]);
  });

  it("resolveSkill returns the SKILL body; unknown skill throws with a list", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "mem"), { type: "memory", name: "Mem", description: "" });
    const s = await svc.resolveSkill("h", "mem", "remember");
    expect(s.body).toMatch(/append/i);
    await expect(svc.resolveSkill("h", "mem", "nope")).rejects.toThrow(/remember|reflect/);
  });

  it("custom module exposes only its module-local skills", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "recipes"), { type: "recipes", name: "Food", description: "" });
    await mkdir(join(root, "recipes", ".claude", "skills", "cook"), { recursive: true });
    await writeFile(join(root, "recipes", ".claude", "skills", "cook", "SKILL.md"), "---\nname: cook\ndescription: cook it\n---\n\nCook.\n");
    const skills = await svc.effectiveSkills("h", "recipes");
    expect(skills.map((s) => s.name)).toEqual(["cook"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/run.test.ts`
Expected: FAIL — `effectiveSkills`/`resolveSkill` do not exist.

- [ ] **Step 3: Implement in `src/container/service.ts`**

Add imports:

```ts
import { discoverModuleSkills, mergeSkills, type Skill } from "../modules/skills.js";
import { vendoredSkills } from "../modules/vendored.js";
```

Add methods to `ContainerService`:

```ts
/** The module's effective skill set: vendored (built-in type) ∪ module-local, local overriding by name. */
async effectiveSkills(container: string, module: string): Promise<Skill[]> {
  const reg = await loadRegistry(this.paths);
  const entry = requireContainer(reg, container);
  const moduleRoot = this.moduleRoot(entry.localPath, module);
  if (!(await moduleManifestExists(moduleRoot))) {
    throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
  }
  const manifest = await loadModuleManifest(moduleRoot);
  const [vendored, local] = await Promise.all([
    vendoredSkills(manifest.type),
    discoverModuleSkills(moduleRoot),
  ]);
  return mergeSkills(vendored, local);
}

/** Resolve one named skill for a module; throws NOT_FOUND listing available skills. */
async resolveSkill(container: string, module: string, skill: string): Promise<Skill> {
  const skills = await this.effectiveSkills(container, module);
  const found = skills.find((s) => s.name === skill);
  if (!found) {
    const names = skills.map((s) => s.name).join(", ") || "(none)";
    throw new OkhError("NOT_FOUND", `Module "${module}" has no skill "${skill}". Available: ${names}.`);
  }
  return found;
}
```

Add the resolved module's skills to the module `inspect` view. In `inspect`'s module branch, compute `const skills = await this.effectiveSkills(container, module);` and include `skills: skills.map(s => ({ name: s.name, description: s.description }))` on the returned `module` object. Extend `InspectResult`'s module case with `skills: Array<{ name: string; description: string }>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/run.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/container/service.ts test/run.test.ts
git commit -m "feat(container): effectiveSkills + resolveSkill; inspect lists module skills" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 13: Prompts — `buildRun`, drop learn/remember/reflect

**Files:**
- Modify: `src/prompts/discipline.ts` (add `loadSkillBody` is not needed — the service returns the body; keep `context`/`onboard`/okf loaders)
- Modify: `src/prompts/meta.ts`
- Modify: `src/prompts/index.ts`
- Test: `test/prompts.test.ts`

- [ ] **Step 1: Update `src/prompts/meta.ts`**

Change `FlowName` to `"ask" | "context" | "onboard" | "run"`. Remove the `learn`/`remember`/`reflect` entries from `flowArgShapes` and `flowMeta`. Add `run`:

```ts
export const flowArgShapes = {
  ask: { container, module: moduleArg, question: z.string().optional().describe(argDescriptions.question) },
  context: { container, task: z.string().optional().describe(argDescriptions.task) },
  onboard: {},
  run: {
    container: z.string().describe("Container name."),
    module: z.string().describe("Module path within the container."),
    skill: z.string().describe("Skill name to run (see inspect for the module's skills)."),
    input: z.string().optional().describe("Freeform payload passed to the skill (e.g. the knowledge to learn, the observation to remember)."),
  },
} as const;
```

Add a `run` entry to `flowMeta`:

```ts
  run: {
    title: "Run (module skill)",
    description:
      "Return the discipline for a module's skill (resolved from the module's type + its own skills), with the target paths and your input injected. " +
      "Guidance only: this returns instructions, it does not perform the work itself.",
  },
```

- [ ] **Step 2: Update `src/prompts/index.ts`**

Remove `buildLearn`, `buildRemember`, `buildReflect`. Add `buildRun`. Reuse `renderTargets`/`WRITE_POLICY`. `buildRun` takes the single resolved container/module target and the resolved skill:

```ts
import type { Skill } from "../modules/skills.js";

export function buildRun(target: ResolvedContainer, module: ResolvedModule, skill: Skill, input?: string): string {
  return `# OKH: run — ${skill.name}

**Skill:** ${skill.name} — ${skill.description}
**Module:** ${module.type} · ${module.name} (\`${module.path}\`) → \`${module.absPath}\`
**Container:** ${target.name} (${target.backend}, sync: ${target.sync}) — \`${target.root}\`
**Input:** ${input ?? "(none provided — clarify with the user)"}

<discipline name="${skill.name}">

${skill.body}

</discipline>

${WRITE_POLICY}`;
}
```

(Export `ResolvedModule` from `service.ts` if not already exported — it is.)

- [ ] **Step 3: Update `src/prompts/discipline.ts`**

Remove `"remember"` and `"reflect"` from the `DisciplineDoc` union (keep `"context"`, `"onboard"`). The vendored-skill bodies now live under `resources/types/**` and are read by the service, not here.

- [ ] **Step 4: Update `test/prompts.test.ts`**

Delete assertions/snapshots for `buildLearn`/`buildRemember`/`buildReflect`. Add a `buildRun` test that feeds a fake `Skill` + resolved target/module and asserts the output contains the skill name, body, module path, and the write policy.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/prompts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/prompts test/prompts.test.ts
git commit -m "feat(prompts): buildRun replaces learn/remember/reflect builders" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 14: Tools — register `run`, remove learn/remember/reflect

**Files:**
- Modify: `src/server/tools.ts` (`registerFlowTools`, imports; add `run`)
- Test: `test/server.test.ts`

- [ ] **Step 1: Write the failing test** (append to `test/server.test.ts`)

Assert the server registers `run`, `ask`, `context`, `onboard`, `inspect`, `add`, `sync`, `config`, and does **not** register `learn`/`remember`/`reflect`. Assert calling `run` for a `memory` module + `skill: "remember"` returns text containing the remember discipline. (Follow the existing server-test harness pattern in `test/server.test.ts` for constructing the server + a temp container.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL — `run` not registered; `remember` still present.

- [ ] **Step 3: Implement in `src/server/tools.ts`**

In `registerFlowTools`, keep `ask` and `context`; delete the `learn`, `remember`, `reflect` registrations. Register `run`:

```ts
server.registerTool(
  "run",
  {
    title: flowMeta.run.title,
    description: flowMeta.run.description,
    annotations: { readOnlyHint: true },
    inputSchema: flowArgShapes.run,
  },
  handler(async (args: { container: string; module: string; skill: string; input?: string }) => {
    const skill = await service.resolveSkill(args.container, args.module, args.skill);
    const targets = await service.resolveTargets(args.container, args.module);
    const target = targets[0];
    const mod = target?.modules.find((m) => m.path === args.module);
    if (!target || !mod) return fail(`Container "${args.container}" has no module "${args.module}".`);
    return ok(buildRun(target, mod, skill, args.input));
  }),
);
```

Update imports: drop `buildLearn`, `buildRemember`, `buildReflect`; add `buildRun`. Keep `buildAsk`, `buildContext`, `buildOnboard`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tools.ts test/server.test.ts
git commit -m "feat(tools): register run; remove learn/remember/reflect tools" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 15: Custom-module end-to-end integration test

**Files:**
- Create: `test/custom-module.test.ts`

- [ ] **Step 1: Write the test**

Add a `local` container via `service.addContainer({ source: <tmpdir>, create: true })`; `addModule({ container, path: "recipes", type: "recipes", name: "Food", create: true })`; drop a `.claude/skills/cook/SKILL.md` into the module; assert `inspect(container, "recipes")` lists the `cook` skill and shows `type: recipes`, and `run`/`resolveSkill(container, "recipes", "cook")` returns the body. Assert `getLoader("recipes")` produced a file-listing overview (items enumerated).

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run test/custom-module.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/custom-module.test.ts
git commit -m "test: custom module type end-to-end with .claude/skills discovery" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 16: Update eval fixtures + scenarios

**Files:**
- Convert: `eval/fixtures/git-hub/.okh/okh.yaml` and `eval/fixtures/kb-hub/.okh/okh.yaml` → per-module `.okh/module.yaml` files (delete the legacy files, or rely on runtime migration but prefer explicit fixtures).
- Modify: `eval/scenarios/learn/*.yaml`, `eval/scenarios/remember/*.yaml`, `eval/scenarios/reflect/*.yaml` → assert the agent uses `run` with the right `skill`.
- Modify: `eval/provision.ts`/environment provisioning if it writes `.okh/okh.yaml` (grep `okh.yaml` under `eval/`).

- [ ] **Step 1: Grep eval for legacy manifests**

Run: `grep -rn "okh.yaml\|type: knowledge\|modules:" eval`
Expected: identifies the two fixtures + any provisioning that writes a container manifest.

- [ ] **Step 2: Convert fixtures**

For each fixture module folder, add `<module>/.okh/module.yaml` with `type`/`name`/`description` and remove the container `.okh/okh.yaml`. (Runtime migration would also handle this, but explicit fixtures keep eval deterministic.)

- [ ] **Step 3: Update learn/remember/reflect scenarios**

In each scenario's assertions/expected transcript, replace the expectation that the agent calls the `learn`/`remember`/`reflect` tool with the expectation that it calls `run { container, module, skill: "learn"|"remember"|"reflect", input }`. Keep `ask`/`context`/`onboard` scenarios unchanged.

- [ ] **Step 4: Validate eval config + eval unit tests**

Run: `npm run typecheck:eval && npm run test:eval && npm run eval:validate`
Expected: typecheck clean; eval unit tests PASS; `Configuration is valid.`

- [ ] **Step 5: Commit**

```bash
git add eval
git commit -m "test(eval): per-module fixtures; learn/remember/reflect route through run" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 17: Docs + full verification

**Files:**
- Modify: `README.md` (MCP surface tables), `CONTEXT.md` / `USAGE.md` / `SETUP.md` as needed to reflect the new module manifest, `run`, and removed verbs.

- [ ] **Step 1: Update README MCP surface**

Replace the flows table so it lists `ask`, `context`, `onboard`, and `run` (generic), and note that `learn`/`remember`/`reflect` are now module-type skills invoked via `run`. Document the per-module `.okh/module.yaml` and that container settings (`sync`) live in the registry. Grep for stale references: `grep -rn "okh.yaml\|remember (flow)\|learn (flow)\|reflect (flow)" README.md CONTEXT.md USAGE.md SETUP.md`.

- [ ] **Step 2: Full local verification**

Run: `npm run typecheck && npm test && npm run build && npm run typecheck:eval && npm run test:eval && npm run eval:validate`
Expected: all green; build emits `dist/`; `Configuration is valid.`

- [ ] **Step 3: Full e2e eval** (required for a change of this size)

Run: `npm run build && npm run eval`
Expected: the live eval harness passes its scenarios (ask/context/onboard unchanged; learn/remember/reflect via `run`). Investigate and fix any scenario regressions before declaring done.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: describe self-contained modules + run tool; verify full suite" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review (completed while writing)

- **Spec coverage:**
  - Goal 1 (self-contained + auto-discovery) → Tasks 1, 2, 6, 9.
  - Goal 2 (name/description in inspect) → Tasks 1, 6, 8.
  - Goal 3 (`llmwiki` later, no arch change) → Task 3 + Task 11 registry shape make adding a built-in type additive; explicitly deferred.
  - Goal 4 (ordered per-type skills incl. maintenance/health) → Tasks 10, 11 (folder-name ordering; any skill name is allowed).
  - Goal 5 (verbs → type skills) → Tasks 11–14 (learn/remember/reflect become vendored skills; `run`).
  - Goal 6 (custom type + `.claude/skills`) → Tasks 3, 10, 15.
  - Container-settings-in-registry, migration, validation → Tasks 4, 5, 7.
- **Placeholder scan:** No "TBD/implement later" steps; each code/test step carries full content.
- **Type consistency:** `discoverModules → DiscoveredModule{path,manifest?,error?}`; `Skill{name,description,body,source}`; `effectiveSkills/resolveSkill` names match across service, prompts (`buildRun`), and tools; module `type` is a `string` end-to-end; `sync` is `SyncMode` from the registry entry everywhere.
- **Known follow-through:** Tasks 6–9 explicitly require updating existing tests/fixtures; the plan calls out each affected test file rather than leaving it implicit.
