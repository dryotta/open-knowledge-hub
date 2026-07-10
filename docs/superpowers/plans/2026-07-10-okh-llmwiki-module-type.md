# llmwiki Module Type — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native `llmwiki` built-in module type — a scope-bounded, OKF-backed living wiki (Karpathy "LLM Wiki" pattern) with a deterministic wiki-health loader and `initialize`/`write`/`lint` vendored skills.

**Architecture:** A new module type reusing the existing loader + vendored-skills + `run` machinery. Pages are OKF concept docs (reuse `okf-writer`); the type's distinction from `knowledge` is its *operating model* (coverage-within-scope, connected graph, human+agent readable), not its format. The loader adds an optional deterministic `health()` (orphans / dangling links / uncataloged / missing-type) surfaced through the existing `inspect` tool. No new MCP tools; the server still runs no LLM and never acts.

**Tech Stack:** TypeScript (Node ESM), Vitest, `yaml`, MCP SDK. Resources are markdown under `resources/`. Design spec: `docs/superpowers/specs/2026-07-10-okh-llmwiki-module-type-design.md`.

**Commit convention:** every commit ends with the standard trailers:
```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 79ba7b3b-b557-48ef-b4eb-492b7e27d59c
```
Task 1's commit shows them in full; later tasks abbreviate as `<trailers>` — always include the two lines above.

---

## File Structure

**Create:**
- `src/modules/loaders/okf.ts` — shared OKF enumeration helper (`okfEnumerate`, `OKF_RESERVED`) used by both `knowledge` and `llmwiki`.
- `src/modules/loaders/llmwiki.ts` — the `llmwiki` loader (`enumerate`/`overview`/`scaffold`/`health`).
- `resources/module-types/llmwiki/index-skeleton.md` — OKF root-index skeleton (contract + empty catalog).
- `resources/module-types/llmwiki/skills/initialize/SKILL.md`
- `resources/module-types/llmwiki/skills/write/SKILL.md`
- `resources/module-types/llmwiki/skills/lint/SKILL.md`
- `eval/fixtures/wiki-hub/wiki/…` — an initialized llmwiki fixture (with a seeded orphan + dangling link for the lint scenario).
- `eval/scenarios/write/into-wiki.yaml`, `eval/scenarios/lint/wiki-health.yaml`
- `test/llmwiki.test.ts` — service-level `inspect` health wiring test.

**Modify:**
- `src/modules/types.ts` — add `"llmwiki"` to `BUILTIN_MODULE_TYPES`; add `WikiHealth` + optional `Loader.health`.
- `src/modules/loaders/knowledge.ts` — delegate `enumerate` to `okfEnumerate`.
- `src/modules/registry.ts` — register `llmwiki: llmwikiLoader`.
- `src/container/service.ts` — `InspectResult` module kind gains optional `health`; `inspect()` calls `health?()`.
- `src/server/tools.ts` — `formatInspect` renders a "Wiki health" block.
- `resources/shared/skills/ingest/SKILL.md` — route `llmwiki` → `write`.
- `resources/prompts/ask.md`, `resources/prompts/context.md`, `resources/prompts/instructions.md`, `resources/prompts/onboard.md`, `resources/tool-meta/add_module.md` — mention `llmwiki`.
- `README.md` — module-types + MCP surface.
- `test/loaders.test.ts`, `test/run.test.ts` — new coverage.
- `eval/environments.ts` — add the `wiki` environment.

---

### Task 1: Register the type + `Loader.health` interface

**Files:**
- Modify: `src/modules/types.ts`
- Test: `test/loaders.test.ts`

- [ ] **Step 1: Write the failing test** — append to the `type registry` describe block in `test/loaders.test.ts` (near line 178):

```typescript
  it("recognises llmwiki as a built-in type", () => {
    expect(isBuiltinType("llmwiki")).toBe(true);
    expect(BUILTIN_MODULE_TYPES).toContain("llmwiki");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/loaders.test.ts -t "llmwiki as a built-in"`
Expected: FAIL (`BUILTIN_MODULE_TYPES` does not contain `"llmwiki"`).

- [ ] **Step 3: Implement** — edit `src/modules/types.ts`. Replace the `BUILTIN_MODULE_TYPES` line and add the `WikiHealth` type + optional `health` on `Loader`:

```typescript
/** The built-in module types. Order is not significant. */
export const BUILTIN_MODULE_TYPES = ["knowledge", "skills", "tools", "memory", "project", "llmwiki"] as const;
```

Then, after the `Item` interface, add:

```typescript
/** Deterministic structural health of an llmwiki module (computed from cross-links). */
export interface WikiHealth {
  /** Concept pages with no inbound link from another concept page. */
  orphans: string[];
  /** Links whose resolved target file does not exist, as { from, to } page paths. */
  danglingLinks: Array<{ from: string; to: string }>;
  /** Concept pages not linked from the root index.md catalog. */
  uncataloged: string[];
  /** Concept pages whose frontmatter lacks a non-empty OKF `type`. */
  missingType: string[];
}
```

And add one optional method to the `Loader` interface (after `scaffold?`):

```typescript
  /** Optional deterministic structural health report (currently: llmwiki). */
  health?(moduleRoot: string): Promise<WikiHealth>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/loaders.test.ts -t "llmwiki as a built-in"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/types.ts test/loaders.test.ts
git commit -m "feat(llmwiki): register type + add Loader.health interface

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 79ba7b3b-b557-48ef-b4eb-492b7e27d59c"
```

---

### Task 2: Shared OKF enumerate helper (DRY)

Extract the OKF concept-enumeration logic so both `knowledge` and `llmwiki` share one source of truth. The existing knowledge-loader tests guard against regressions.

**Files:**
- Create: `src/modules/loaders/okf.ts`
- Modify: `src/modules/loaders/knowledge.ts`
- Test: `test/loaders.test.ts` (existing knowledge tests are the regression guard)

- [ ] **Step 1: Create the helper** — `src/modules/loaders/okf.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { parseFrontmatter, stringField } from "../../util/frontmatter.js";
import { walkFiles } from "../fs.js";
import type { Item } from "../types.js";

/** OKF reserved filenames — never concept documents. */
export const OKF_RESERVED = new Set(["index.md", "log.md"]);

/** Enumerate OKF concept docs under a module root (skips reserved files). */
export async function okfEnumerate(moduleRoot: string, defaultType = "concept"): Promise<Item[]> {
  const files = await walkFiles(moduleRoot, (n) => n.endsWith(".md"));
  const items: Item[] = [];

  for (const rel of files) {
    if (OKF_RESERVED.has(basename(rel))) continue;

    let text: string;
    try {
      text = await readFile(join(moduleRoot, rel), "utf8");
    } catch {
      continue;
    }

    const { data } = parseFrontmatter(text);
    items.push({
      path: rel,
      title: stringField(data, "title") ?? basename(rel, ".md"),
      description: stringField(data, "description") ?? "",
      type: stringField(data, "type") ?? defaultType,
    });
  }

  return items;
}
```

- [ ] **Step 2: Refactor the knowledge loader to use it** — replace the entire contents of `src/modules/loaders/knowledge.ts` with:

```typescript
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { okfEnumerate } from "./okf.js";
import type { Item, Loader } from "../types.js";

// The starter index.md written into a new knowledge module. Authored as an
// editable resource; resolves from src (tsx) and dist (built).
const INDEX_SKELETON_URL = new URL("../../../resources/module-types/knowledge/index-skeleton.md", import.meta.url);

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function enumerate(moduleRoot: string): Promise<Item[]> {
  return okfEnumerate(moduleRoot, "concept");
}

async function overview(moduleRoot: string): Promise<string> {
  try {
    return await readFile(join(moduleRoot, "index.md"), "utf8");
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  const items = await enumerate(moduleRoot);
  if (items.length === 0) return "# Knowledge\n\n_Empty module (no index.md, no concepts)._\n";
  const lines = items.map((i) => `* ${i.title}${i.description ? ` — ${i.description}` : ""} (\`${i.path}\`)`);
  return `# Knowledge (generated index)\n\n${lines.join("\n")}\n`;
}

async function scaffold(moduleRoot: string): Promise<void> {
  await mkdir(moduleRoot, { recursive: true });
  const skeleton = await readFile(fileURLToPath(INDEX_SKELETON_URL), "utf8");
  await writeFile(join(moduleRoot, "index.md"), skeleton, { encoding: "utf8", flag: "wx" });
}

export const knowledgeLoader: Loader = { enumerate, overview, scaffold };
```

- [ ] **Step 3: Run the knowledge loader tests (regression guard)**

Run: `npx vitest run test/loaders.test.ts -t "knowledge loader"`
Expected: PASS (all 5 knowledge-loader cases unchanged).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/modules/loaders/okf.ts src/modules/loaders/knowledge.ts
git commit -m "refactor(loaders): extract shared okfEnumerate helper

<trailers>"
```

---

### Task 3: The `llmwiki` loader — enumerate / overview / scaffold

**Files:**
- Create: `src/modules/loaders/llmwiki.ts`
- Create: `resources/module-types/llmwiki/index-skeleton.md`
- Modify: `src/modules/registry.ts`
- Test: `test/loaders.test.ts`

- [ ] **Step 1: Author the index skeleton** — `resources/module-types/llmwiki/index-skeleton.md`:

```markdown
---
okf_version: "0.1"
---

# Wiki

<!--
Scope contract + catalog for this llmwiki (an OKF bundle). `initialize` fills this in; `write`
and `lint` keep it current. Replace each TODO and delete these hints as you go.
-->

> **Purpose:** TODO — one line on what this wiki is for.

## Goals

TODO — who reads this wiki (humans and/or agents) and what they need. Goals are the yardstick for
what belongs here.

## Scope

- **In scope:** TODO — the topics this wiki covers.
- **Out of scope:** TODO — what it deliberately excludes, and briefly why.

## Structure

- **Groups / folders** — TODO — the group folders (each has its own `index.md`).
- **Concept types** — TODO — the OKF `type` vocabulary used across pages (declare each).
- **Tags** — TODO — any cross-cutting tags (optional).
- **Links** — OKF bundle-relative links between pages, e.g. `[x](/group/x.md)`. Every page links to
  at least one other (no orphans).

## Sources

<!-- Optional retention policy. Default: do not keep copies. To retain a copy of each ingested
source, set Retain copies: yes and adjust Folder/Bucketing. The `ingest` skill honors this. -->

Retain copies: no

## Catalog

Progressive-disclosure listing (grouped by folder; each entry is title — one-line description).

_None yet._
```

- [ ] **Step 2: Write the failing tests** — add a new describe block to `test/loaders.test.ts` (after the knowledge-loader block). Also import the loader at the top of the file:

Add import near the other loader imports (top of file):
```typescript
import { llmwikiLoader } from "../src/modules/loaders/llmwiki.js";
```

Add the describe block:
```typescript
describe("llmwiki loader", () => {
  it("enumerates OKF pages (excluding index.md/log.md), defaulting type to page", async () => {
    const root = await tmp();
    await write(root, "index.md", "# idx\n");
    await write(root, "log.md", "# log\n");
    await write(root, "concepts/attn.md", "---\ntitle: Attention\ndescription: attn\ntype: concept\n---\nbody");
    await write(root, "notes/misc.md", "no frontmatter");

    const items = await llmwikiLoader.enumerate(root);

    expect(items.map((i) => i.path).sort()).toEqual(["concepts/attn.md", "notes/misc.md"]);
    expect(items.find((i) => i.path === "concepts/attn.md")).toMatchObject({ title: "Attention", type: "concept" });
    expect(items.find((i) => i.path === "notes/misc.md")!.type).toBe("page");
  });

  it("overview returns index.md when present, else a wiki-labeled listing", async () => {
    const root = await tmp();
    await write(root, "index.md", "# My Wiki\n");
    expect(await llmwikiLoader.overview(root)).toContain("# My Wiki");

    const root2 = await tmp();
    await write(root2, "concepts/x.md", "---\ntitle: X\n---\n");
    const ov = await llmwikiLoader.overview(root2);
    expect(ov).toContain("Wiki (generated index)");
    expect(ov).toContain("X");
  });

  it("scaffold writes an index.md skeleton and a log.md seed", async () => {
    const root = await tmp();
    await llmwikiLoader.scaffold!(root);
    const ov = await llmwikiLoader.overview(root);
    expect(ov).toContain("okf_version");
    expect(ov).toContain("## Scope");
    const log = await import("node:fs/promises").then((m) => m.readFile(join(root, "log.md"), "utf8"));
    expect(log).toContain("Update Log");
  });

  it("scaffold does not overwrite an existing index.md", async () => {
    const root = await tmp();
    await write(root, "index.md", "# Existing\n");
    await expect(llmwikiLoader.scaffold!(root)).rejects.toMatchObject({ code: "EEXIST" });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/loaders.test.ts -t "llmwiki loader"`
Expected: FAIL (module `../src/modules/loaders/llmwiki.js` not found).

- [ ] **Step 4: Implement the loader** — `src/modules/loaders/llmwiki.ts` (health added in Task 4; for now `enumerate`/`overview`/`scaffold`):

```typescript
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { okfEnumerate } from "./okf.js";
import type { Item, Loader } from "../types.js";

const INDEX_SKELETON_URL = new URL("../../../resources/module-types/llmwiki/index-skeleton.md", import.meta.url);
const LOG_SEED = "# Update Log\n\n<!-- Newest entries first. Each entry: `## YYYY-MM-DD` then bullets. -->\n";

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function enumerate(moduleRoot: string): Promise<Item[]> {
  return okfEnumerate(moduleRoot, "page");
}

async function overview(moduleRoot: string): Promise<string> {
  try {
    return await readFile(join(moduleRoot, "index.md"), "utf8");
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  const items = await enumerate(moduleRoot);
  if (items.length === 0) return "# Wiki\n\n_Empty wiki (no index.md, no pages)._\n";
  const lines = items.map((i) => `* ${i.title}${i.description ? ` — ${i.description}` : ""} (\`${i.path}\`)`);
  return `# Wiki (generated index)\n\n${lines.join("\n")}\n`;
}

async function scaffold(moduleRoot: string): Promise<void> {
  await mkdir(moduleRoot, { recursive: true });
  const skeleton = await readFile(fileURLToPath(INDEX_SKELETON_URL), "utf8");
  await writeFile(join(moduleRoot, "index.md"), skeleton, { encoding: "utf8", flag: "wx" });
  await writeFile(join(moduleRoot, "log.md"), LOG_SEED, { encoding: "utf8", flag: "wx" });
}

export const llmwikiLoader: Loader = { enumerate, overview, scaffold };
```

- [ ] **Step 5: Register the loader** — edit `src/modules/registry.ts`. Add the import and the map entry:

```typescript
import { llmwikiLoader } from "./loaders/llmwiki.js";
```

```typescript
const LOADERS: Record<ModuleType, Loader> = {
  knowledge: knowledgeLoader,
  skills: skillsLoader,
  tools: toolsLoader,
  memory: memoryLoader,
  project: projectLoader,
  llmwiki: llmwikiLoader,
};
```

- [ ] **Step 6: Extend the dispatch test** — in `test/loaders.test.ts`, update the `getLoader dispatch` loop to include `llmwiki`:

```typescript
    for (const t of ["knowledge", "skills", "tools", "memory", "project", "llmwiki"] as const) {
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/loaders.test.ts`
Expected: PASS (all loader tests, including the new llmwiki block and dispatch).

- [ ] **Step 8: Commit**

```bash
git add src/modules/loaders/llmwiki.ts src/modules/registry.ts resources/module-types/llmwiki/index-skeleton.md test/loaders.test.ts
git commit -m "feat(llmwiki): add loader (enumerate/overview/scaffold) + index skeleton

<trailers>"
```

---

### Task 4: The `llmwiki` loader — `health()`

Deterministic structural checks over OKF cross-links.

**Files:**
- Modify: `src/modules/loaders/llmwiki.ts`
- Test: `test/loaders.test.ts`

- [ ] **Step 1: Write the failing test** — add to the `llmwiki loader` describe block in `test/loaders.test.ts`:

```typescript
  it("health reports orphans, dangling links, uncataloged pages, and missing type", async () => {
    const root = await tmp();
    await write(root, "index.md", "---\nokf_version: \"0.1\"\n---\n# Wiki\n## Catalog\n* [Attention](/concepts/attention.md) - attn\n");
    await write(root, "log.md", "# Update Log\n");
    await write(root, "concepts/attention.md", "---\ntype: concept\ntitle: Attention\n---\nSee [Transformer](/entities/transformer.md) and [Missing](/concepts/missing.md).\n");
    await write(root, "entities/transformer.md", "---\ntype: entity\ntitle: Transformer\n---\nUses [Attention](/concepts/attention.md).\n");
    await write(root, "concepts/orphan.md", "---\ntitle: Orphan\n---\nNothing links here.\n");

    const h = await llmwikiLoader.health!(root);

    expect(h.orphans).toEqual(["concepts/orphan.md"]);
    expect(h.danglingLinks).toEqual([{ from: "concepts/attention.md", to: "concepts/missing.md" }]);
    expect(h.uncataloged.sort()).toEqual(["concepts/orphan.md", "entities/transformer.md"]);
    expect(h.missingType).toEqual(["concepts/orphan.md"]);
  });

  it("health is clean for a fully connected, cataloged wiki", async () => {
    const root = await tmp();
    await write(root, "index.md", "# Wiki\n## Catalog\n* [A](/a.md)\n* [B](/b.md)\n");
    await write(root, "a.md", "---\ntype: concept\ntitle: A\n---\n[B](/b.md)\n");
    await write(root, "b.md", "---\ntype: concept\ntitle: B\n---\n[A](/a.md)\n");

    const h = await llmwikiLoader.health!(root);

    expect(h).toEqual({ orphans: [], danglingLinks: [], uncataloged: [], missingType: [] });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/loaders.test.ts -t "health reports"`
Expected: FAIL (`llmwikiLoader.health` is undefined).

- [ ] **Step 3: Implement `health`** — edit `src/modules/loaders/llmwiki.ts`. Add imports for `basename`, `posix`, the frontmatter helpers, `walkFiles`, `OKF_RESERVED`, and `WikiHealth`:

Change the import lines to:
```typescript
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, basename, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, stringField } from "../../util/frontmatter.js";
import { walkFiles } from "../fs.js";
import { okfEnumerate, OKF_RESERVED } from "./okf.js";
import type { Item, Loader, WikiHealth } from "../types.js";
```

Add the link-matcher, resolver, and `health` before the `export const` line:

```typescript
// Markdown links [text](target); the negative lookbehind skips images ![alt](src).
const LINK_RE = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;

/** Resolve a markdown link target to a module-relative POSIX path, or undefined if not an in-module .md link. */
function resolveLink(fromRel: string, target: string): string | undefined {
  const t = target.split("#")[0]!.split("?")[0]!.trim();
  if (!t) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return undefined; // scheme (http:, mailto:, …) → external
  if (!t.endsWith(".md")) return undefined;
  const resolved = t.startsWith("/")
    ? t.slice(1)
    : posix.normalize(posix.join(posix.dirname(fromRel), t));
  if (resolved.startsWith("..")) return undefined; // escapes the module → not our concern
  return resolved.replace(/^\.\//, "");
}

async function health(moduleRoot: string): Promise<WikiHealth> {
  const pages = await walkFiles(moduleRoot, (n) => n.endsWith(".md"));
  const existing = new Set(pages);
  const concepts = pages.filter((p) => !OKF_RESERVED.has(basename(p)));

  const inbound = new Map<string, number>();
  for (const c of concepts) inbound.set(c, 0);

  const danglingLinks: Array<{ from: string; to: string }> = [];
  const catalogTargets = new Set<string>();
  const missingType: string[] = [];

  for (const page of pages) {
    let text: string;
    try {
      text = await readFile(join(moduleRoot, page), "utf8");
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(text);
    const isReserved = OKF_RESERVED.has(basename(page));
    if (!isReserved && !stringField(data, "type")) missingType.push(page);

    for (const m of body.matchAll(LINK_RE)) {
      const to = resolveLink(page, m[1]!);
      if (!to) continue;
      if (!existing.has(to)) {
        danglingLinks.push({ from: page, to });
        continue;
      }
      if (basename(page) === "index.md") catalogTargets.add(to);
      else if (inbound.has(to)) inbound.set(to, inbound.get(to)! + 1);
    }
  }

  const orphans = concepts.filter((c) => (inbound.get(c) ?? 0) === 0);
  const uncataloged = concepts.filter((c) => !catalogTargets.has(c));
  return { orphans, danglingLinks, uncataloged, missingType };
}
```

Update the export to include `health`:
```typescript
export const llmwikiLoader: Loader = { enumerate, overview, scaffold, health };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/loaders.test.ts -t "health"`
Expected: PASS (both health cases).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/modules/loaders/llmwiki.ts test/loaders.test.ts
git commit -m "feat(llmwiki): deterministic health() over OKF cross-links

<trailers>"
```

---

### Task 5: Surface health in `inspect`

**Files:**
- Modify: `src/container/service.ts`
- Modify: `src/server/tools.ts`
- Test: `test/llmwiki.test.ts` (new)

- [ ] **Step 1: Write the failing test** — `test/llmwiki.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
  await saveRegistry(paths, {
    version: 1,
    containers: [{ name: "h", backend: "local", localPath: root, sync: "auto", addedAt: new Date().toISOString() }],
  });
  return { root, svc: new ContainerService(paths) };
}

describe("inspect surfaces llmwiki health", () => {
  it("returns a health block with orphans for an llmwiki module", async () => {
    const { root, svc } = await setup();
    const mod = join(root, "wiki");
    await saveModuleManifest(mod, { type: "llmwiki", name: "Wiki", description: "" });
    await writeFile(join(mod, "index.md"), "# Wiki\n", "utf8");
    await mkdir(join(mod, "concepts"), { recursive: true });
    await writeFile(join(mod, "concepts", "orphan.md"), "---\ntype: concept\ntitle: Orphan\n---\nalone\n", "utf8");

    const result = await svc.inspect("h", "wiki");
    if (result.kind !== "module") throw new Error("expected module result");
    expect(result.health?.orphans).toContain("concepts/orphan.md");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/llmwiki.test.ts`
Expected: FAIL (`result.health` is `undefined`).

- [ ] **Step 3: Add `health` to the InspectResult type + inspect()** — edit `src/container/service.ts`.

First, ensure `WikiHealth` is imported. Find the import of module types (it imports `Item`) and add `WikiHealth`. If `Item` is imported from `../modules/types.js`, extend that import; otherwise add:
```typescript
import type { WikiHealth } from "../modules/types.js";
```

In the `InspectResult` union, the `kind: "module"` member (around line 207-213) — add the optional field:
```typescript
  | {
      kind: "module";
      module: { path: string; type: string; name: string; description: string; config?: Record<string, unknown> };
      overview: string;
      items: Item[];
      skills: Array<{ name: string; description: string }>;
      health?: WikiHealth;
    };
```

In `inspect()` (the module branch, around lines 369-378), compute health and include it:
```typescript
    const items = await this.safeEnumerate(manifest.type, moduleRoot);
    const skills = await this.effectiveSkills(container, module);
    const loader = getLoader(manifest.type);
    const overview = await loader.overview(moduleRoot).catch(() => "");
    const health = await loader.health?.(moduleRoot).catch(() => undefined);
    return {
      kind: "module",
      module: { path: module, type: manifest.type, name: manifest.name, description: manifest.description, ...(manifest.config ? { config: manifest.config } : {}) },
      overview,
      items,
      skills: skills.map((s) => ({ name: s.name, description: s.description })),
      ...(health ? { health } : {}),
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/llmwiki.test.ts`
Expected: PASS.

- [ ] **Step 5: Render the health block in `formatInspect`** — edit `src/server/tools.ts`. In `formatInspect`, the final module branch (ends `return [head, ...items, "Skills:", ...skillLines, ...overviewLines].join("\n");`). Insert health rendering before that return:

```typescript
  const healthLines: string[] = [];
  if (r.health) {
    const h = r.health;
    const clean = !h.orphans.length && !h.danglingLinks.length && !h.uncataloged.length && !h.missingType.length;
    healthLines.push("Wiki health:");
    if (clean) {
      healthLines.push("  clean");
    } else {
      if (h.orphans.length) healthLines.push(`  Orphans (${h.orphans.length}): ${h.orphans.join(", ")}`);
      if (h.danglingLinks.length)
        healthLines.push(`  Dangling links (${h.danglingLinks.length}): ${h.danglingLinks.map((d) => `${d.from} → ${d.to}`).join(", ")}`);
      if (h.uncataloged.length) healthLines.push(`  Uncataloged (${h.uncataloged.length}): ${h.uncataloged.join(", ")}`);
      if (h.missingType.length) healthLines.push(`  Missing type (${h.missingType.length}): ${h.missingType.join(", ")}`);
    }
  }
  return [head, ...items, "Skills:", ...skillLines, ...overviewLines, ...healthLines].join("\n");
```

- [ ] **Step 6: Type-check + run the suite touched here**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.
Run: `npx vitest run test/llmwiki.test.ts test/inspect.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/container/service.ts src/server/tools.ts test/llmwiki.test.ts
git commit -m "feat(llmwiki): surface wiki health in inspect output

<trailers>"
```

---

### Task 6: Vendored skills — `initialize`, `write`, `lint`

**Files:**
- Create: `resources/module-types/llmwiki/skills/initialize/SKILL.md`
- Create: `resources/module-types/llmwiki/skills/write/SKILL.md`
- Create: `resources/module-types/llmwiki/skills/lint/SKILL.md`
- Test: `test/run.test.ts`

> Frontmatter `description` must not contain an unquoted `": "` (colon-space) — it silently drops the skill from discovery. The three below use em-dashes only.

- [ ] **Step 1: Write the failing discoverability test** — add to the `effective skills + resolveSkill` describe block in `test/run.test.ts`:

```typescript
  it("llmwiki type exposes initialize + lint + write", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "wiki"), { type: "llmwiki", name: "Wiki", description: "" });
    const names = (await svc.effectiveSkills("h", "wiki")).map((s) => s.name).sort();
    expect(names).toEqual(["initialize", "lint", "write"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/run.test.ts -t "llmwiki type exposes"`
Expected: FAIL (no vendored skills → `[]`).

- [ ] **Step 3: Author `initialize`** — `resources/module-types/llmwiki/skills/initialize/SKILL.md`:

```markdown
---
name: initialize
description: Shape a newly-created llmwiki module — grill its scope and pick a structure template, then scaffold that structure (empty wiki) or fit existing content to it.
---

# Initialize an llmwiki module

The module already exists (name, type, and description were set when it was added). Give it a
scope-bounded shape: an agreed scope contract and an organized OKF structure. This wiki is a
*living* knowledge base — it welcomes breadth **within its declared scope** and is read by **both
humans and agents**. The failure mode is a wiki with no boundary, not a small one.

Pages are OKF concept docs, authored later with the shared **okf-writer** skill. This skill only
sets up the contract and structure.

## Stage 1 — Grill the scope and structure

Run the shared **grilling** skill (`run { skill: "grilling" }`), then record the agreed **scope
contract** in the module's root `index.md` (its skeleton lays out these sections):

- **Purpose & Goals** — one line on what the wiki is for; who reads it (humans and/or agents) and
  what they need. Goals are the yardstick for every later decision.
- **In scope / Out of scope** — the topics this wiki covers and, explicitly, those it does not.
  This is the gate every page is judged against.
- **Structure** — offer a **template menu** and let the user pick and adapt:
  - **Encyclopedia** — `concepts/`, `entities/`, `summaries/`, `syntheses/`
  - **Diátaxis** — `tutorials/`, `how-to/`, `reference/`, `explanation/`
  - **Topic tree** — nested topic folders, each with its own `index.md`
  - **Codebase map** — `components/`, `flows/`, `decisions/`, `glossary/`
  - **Custom** — user-declared folders
  Record the chosen group folders, the OKF concept **`type`** vocabulary (declare each type), and
  any **tags**.
- **Sources retention** (optional) — whether ingested source documents are kept in the module.
  Default **no**. If yes, write a `## Sources` section recording **Retain copies: yes**, the
  **Folder** (default `./sources/`) and **Bucketing** (default `<YYYY-MM>/`). The `ingest` skill
  honors this.

Grill until goals, in/out-of-scope, and structure are sharp. Reject unbounded scope — "everything
about X" is not a boundary.

## Stage 2 — Build to the contract

**Empty wiki (the common case)** — write the scope contract to the root `index.md`, create the
declared group folders (each with its own stub `index.md`), and seed `log.md`. **Do not invent
content** — pages accrue through the `write` skill. You're done.

**Existing content** — review it against the scope with the shared **okf-writer** skill. Keep and
map what fits; cut what's out of scope; fix or flag `⚠️ UNVERIFIED` any claim you can't back up;
note gaps for `write`. Then update `index.md`'s catalog.

## Completion criterion

- A scope contract (purpose + goals + in/out-of-scope + structure with declared types) exists in
  `index.md`.
- **Empty wiki:** the declared group folders exist (each with `index.md`); `log.md` is seeded; no
  invented content.
- **Existing content:** it follows the structure and stays within scope; every claim is backed or
  flagged.
```

- [ ] **Step 4: Author `write`** — `resources/module-types/llmwiki/skills/write/SKILL.md`:

```markdown
---
name: write
description: Integrate new material into this llmwiki — author OKF pages, touch every affected page, maintain cross-links, and update the index and log.
---

# Write to an llmwiki module

Fold new material into this wiki as OKF concept pages, keeping the graph connected and the index
current. A single source or insight typically **touches several pages** — that is expected. Author
all pages with the shared **okf-writer** skill (`run { skill: "okf-writer" }`) for OKF format and
citation rules. Run these stages in order.

## Stage 1 — Load the scope contract

Read the module's `index.md` and recover its **scope contract**: goals, in-scope, out-of-scope.
Restate it in one line. Do not run this on an uninitialized module — if there is no contract, run
`initialize` first. A wiki with zero pages but a written contract is initialized; do not
re-initialize it.

## Stage 2 — The scope gate (coverage within scope)

Unlike a knowledge module's default-NO gate, a wiki **welcomes breadth within its declared scope**.
Decide:

- **In scope** → proceed.
- **Out of scope** → do not silently expand scope. Run the shared **grilling** skill to propose the
  *smallest* scope change that would admit it and get the user's explicit agreement, then re-judge.
  If the user declines, leave it out and say why.

## Stage 3 — Integrate (touch every affected page)

- **Prefer updating existing pages** over creating near-duplicates; create a new page only for a
  genuinely distinct concept/entity.
- Create/update pages under the declared group folders using the declared `type` vocabulary.
- **Cross-link both directions**: link the new/updated page to related pages and add the reciprocal
  links. Use OKF bundle-relative links (`/group/page.md`). A page with no inbound link is an
  orphan — link it.
- **Flag contradictions**: when new material conflicts with an existing page, surface it (note both
  claims) rather than silently overwriting.
- **Ground every non-trivial claim** per okf-writer: cite the source under `# Citations`, or flag
  `⚠️ UNVERIFIED`. Where knowledge comes from the user, attribute it.

## Stage 4 — Update the index and log

- Update the root `index.md` catalog: add new entries, refresh changed descriptions, and declare
  any new `type`.
- Append a dated entry to `log.md` (newest first): what was ingested, pages created/updated, and any
  contradictions flagged.

## Stage 5 — Re-check health

Run `inspect { container, module }` and clear what its **Wiki health** block reports: no orphans, no
dangling links (create the missing page or fix the link), every page cataloged and carrying a
`type`.

## Completion criterion

- Every admitted piece of material is filed into OKF pages within scope, cross-linked both ways, and
  grounded or flagged.
- `index.md` and `log.md` are current.
- `inspect` wiki-health is clean, or the remaining items are intentional and noted in the log.
```

- [ ] **Step 5: Author `lint`** — `resources/module-types/llmwiki/skills/lint/SKILL.md`:

```markdown
---
name: lint
description: Health-check this llmwiki — read the deterministic structural report, then fix contradictions, stale claims, and missing links, and suggest what to write next.
---

# Lint an llmwiki module

Keep the wiki healthy as it grows. Structural checks are computed for you deterministically; your
job is the **judgment** on top. Run these stages in order.

## Stage 1 — Read the structural report

Run `inspect { container, module }`. Its **Wiki health** block lists, deterministically:

- **orphans** — pages with no inbound link from another page
- **dangling links** — links whose target file does not exist
- **uncataloged** — pages missing from `index.md`
- **missing type** — pages whose frontmatter lacks an OKF `type`

## Stage 2 — Fix the mechanical issues

Author edits with the shared **okf-writer** skill (`run { skill: "okf-writer" }`):

- Add the missing inbound links (or, if a page truly belongs nowhere, question whether it should
  exist).
- Resolve each dangling link: create the not-yet-written page, or correct the link.
- Add uncataloged pages to `index.md`; add a `type` to any page missing one.

## Stage 3 — The judgment sweep

Read the wiki (start from `index.md`) and look for what a machine can't:

- **Contradictions** between pages — reconcile, or flag both claims.
- **Stale claims** newer material has superseded — update and note in the log.
- **Missing pages** — concepts mentioned repeatedly but lacking their own page.
- **Missing cross-references** — related pages that should link but don't.
- **Thin or unsupported pages** — strengthen, ground, or prune.

Fix what you can safely; **report** anything needing a human decision; **suggest** new questions to
explore or sources to find.

## Stage 4 — Log it

Append a dated `Lint` entry to `log.md`: what you fixed, what you flagged, and what to do next.

## Completion criterion

- Every structural issue from `inspect` is fixed or explicitly deferred with a reason.
- Contradictions and stale claims are reconciled or flagged.
- `log.md` records the pass and its follow-ups.
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/run.test.ts -t "llmwiki type exposes"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add resources/module-types/llmwiki/skills test/run.test.ts
git commit -m "feat(llmwiki): vendored initialize/write/lint skills

<trailers>"
```

---

### Task 7: Wire `ingest` routing + navigation/help text

**Files:**
- Modify: `resources/shared/skills/ingest/SKILL.md`
- Modify: `resources/prompts/ask.md`
- Modify: `resources/prompts/context.md`
- Modify: `resources/prompts/instructions.md`
- Modify: `resources/prompts/onboard.md`
- Modify: `resources/tool-meta/add_module.md`
- Test: `test/run.test.ts`

- [ ] **Step 1: Write the failing test** — extend the ingest shared-skill test in `test/run.test.ts` (the `resolveSharedSkill returns the ingest body` case) with a routing assertion:

```typescript
    expect(s.body).toMatch(/llmwiki/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/run.test.ts -t "ingest body"`
Expected: FAIL (`ingest` body does not mention `llmwiki`).

- [ ] **Step 3: Route ingest → write** — edit `resources/shared/skills/ingest/SKILL.md`.

In the intro (Stage 0 paragraph, "route each to the **target module's own skill** (`learn` for knowledge, `remember` for memory)"), change to:
```
route each to the **target module's own skill** (`learn` for knowledge, `remember` for memory,
`write` for llmwiki), which owns the scope gate and the actual writing.
```

In Stage 5's routing list, add the third bullet:
```
- **llmwiki** → `run { container, module, skill: "write" }`
```

- [ ] **Step 4: Add llmwiki navigation to `ask` and `context`.**

In `resources/prompts/ask.md` (the header paragraph, "starting from each module's overview (knowledge: index.md; skills/tools: the listing; memory/project: recent files)"), change the parenthetical to:
```
(knowledge/llmwiki: index.md; skills/tools: the listing; memory/project: recent files)
```
And in Stage 2 point 5 (the "Suggest next steps" bullet that points at `learn`), append after the `learn`/`initialize` mention:
```
For an llmwiki module, point at its `write` skill to file a durable answer back as a page.
```

In `resources/prompts/context.md` (the analogous per-type navigation line, "knowledge's `index.md`; skills/tools: the item listing; memory/project: recent files"), change to:
```
knowledge/llmwiki `index.md`; skills/tools: the item listing; memory/project: recent files
```

- [ ] **Step 5: Mention llmwiki in the type lists.**

In `resources/prompts/instructions.md` (the "typed modules (knowledge, skills, tools, memory, project)" phrase), change to:
```
typed modules (knowledge, skills, tools, memory, project, llmwiki)
```

In `resources/prompts/onboard.md` (line listing "`tools`, `memory`, or `project`."), change to:
```
  `tools`, `memory`, `project`, or `llmwiki`.
```

In `resources/tool-meta/add_module.md` (the `type:` description "a built-in (knowledge, skills, tools, memory, project)"), change to:
```
  type: "Module type: a built-in (knowledge, skills, tools, memory, project, llmwiki) or a custom type name (required when create:true)."
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/run.test.ts test/prompts.test.ts test/templates.test.ts test/toolMeta.test.ts`
Expected: PASS. (If any test asserts an exact type list or rendered prompt text, update that assertion to include `llmwiki`.)

- [ ] **Step 7: Commit**

```bash
git add resources/shared/skills/ingest/SKILL.md resources/prompts/ask.md resources/prompts/context.md resources/prompts/instructions.md resources/prompts/onboard.md resources/tool-meta/add_module.md test/run.test.ts
git commit -m "feat(llmwiki): route ingest to write + add navigation/help text

<trailers>"
```

---

### Task 8: README docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the Module bullet** — in `README.md`, change the built-in types sentence (currently "Built-in types: `knowledge` (OKF markdown), `memory`."):

```markdown
  Built-in types: `knowledge` (OKF markdown), `llmwiki` (OKF-backed living wiki), `memory`. Custom
  types (any other string) use a generic file-listing loader; skills come entirely from the module.
```

- [ ] **Step 2: Update the Type skills paragraph** — change the vendored-skills sentence to include llmwiki:

```markdown
Built-in types ship vendored skills: `knowledge` → `learn`, `initialize`; `llmwiki` → `initialize`,
`write`, `lint`; `memory` → `remember`, `reflect` (under `resources/module-types/<type>/skills/`).
```

- [ ] **Step 3: Verify no build/test needed (docs only), then commit**

```bash
git add README.md
git commit -m "docs: document the llmwiki module type

<trailers>"
```

---

### Task 9: Eval — fixture, environment, and scenarios

**Files:**
- Create: `eval/fixtures/wiki-hub/wiki/.okh/module.yaml`
- Create: `eval/fixtures/wiki-hub/wiki/index.md`
- Create: `eval/fixtures/wiki-hub/wiki/log.md`
- Create: `eval/fixtures/wiki-hub/wiki/concepts/attention.md`
- Create: `eval/fixtures/wiki-hub/wiki/entities/transformer.md`
- Modify: `eval/environments.ts`
- Create: `eval/scenarios/write/into-wiki.yaml`
- Create: `eval/scenarios/lint/wiki-health.yaml`

> The `attention.md` page intentionally contains a dangling link to a not-yet-written page so the
> `lint` scenario has real structural work to do.

- [ ] **Step 1: Create the fixture manifest** — `eval/fixtures/wiki-hub/wiki/.okh/module.yaml`:

```yaml
type: llmwiki
name: ml-wiki
description: A small wiki about transformer internals.
```

- [ ] **Step 2: Create the fixture pages.**

`eval/fixtures/wiki-hub/wiki/index.md`:
```markdown
---
okf_version: "0.1"
---

# ML Wiki

> **Purpose:** A living wiki about transformer internals, for engineers and agents.

## Goals

Help a reader (human or agent) understand transformer components and how they connect.

## Scope

- **In scope:** transformer architecture, attention, inference-time optimizations.
- **Out of scope:** training infrastructure, unrelated ML models.

## Structure

- **Groups / folders** — `concepts/`, `entities/`.
- **Concept types** — `concept`, `entity`.
- **Links** — OKF bundle-relative, e.g. `[x](/concepts/x.md)`. No orphans.

## Sources

Retain copies: no

## Catalog

### concepts
* [Attention](/concepts/attention.md) — how attention weights tokens

### entities
* [Transformer](/entities/transformer.md) — the overall architecture
```

`eval/fixtures/wiki-hub/wiki/log.md`:
```markdown
# Update Log

## 2026-07-10
* **Setup**: seeded [Attention](/concepts/attention.md) and [Transformer](/entities/transformer.md).
```

`eval/fixtures/wiki-hub/wiki/concepts/attention.md`:
```markdown
---
type: concept
title: Attention
description: how attention weights tokens
tags: [attention, transformers]
---

Attention lets a model weigh other tokens when encoding one. See the
[Transformer](/entities/transformer.md) it lives in, and the yet-to-be-written
[KV cache](/concepts/kv-cache.md) optimization.
```

`eval/fixtures/wiki-hub/wiki/entities/transformer.md`:
```markdown
---
type: entity
title: Transformer
description: the overall architecture
tags: [transformers]
---

A stack of blocks built on [Attention](/concepts/attention.md).
```

- [ ] **Step 3: Register the environment** — edit `eval/environments.ts`. Add to the `environments` object (after `health`):

```typescript
  wiki: {
    placement: "registered",
    hubs: [{ container: "wiki-hub", fixture: "fixtures/wiki-hub", backend: "local" }],
    workspaceDir: undefined,
  },
```

- [ ] **Step 4: Create the `write` scenario** — `eval/scenarios/write/into-wiki.yaml`:

```yaml
# write flow — add an in-scope page to an existing llmwiki, cross-linked, index+log updated.
- config:
    - vars:
        env: wiki
        prompt: |
          Use the open-knowledge-hub MCP tools. Add this to my ml-wiki wiki (container
          "wiki-hub", module "wiki"): "KV cache stores past keys and values so decoding
          is linear per new token instead of quadratic." Then sync.
  tests:
    - description: Write - in-scope page - integrates, cross-links, syncs
      assert:
        - type: javascript
          value: file://assertions/tools-called.ts
          config: { expect: [run, sync] }
        - type: javascript
          value: file://assertions/okf-valid.ts
          config: { module: wiki, requireChanged: true }
        - type: javascript
          value: file://assertions/judge.ts
          config:
            criteria:
              - id: created-kv-page
                text: A new OKF page about the KV cache was created under the wiki module (e.g. concepts/kv-cache.md).
              - id: cross-linked
                text: The new page links to and/or is linked from a related page (e.g. Attention), not left as an orphan.
              - id: index-and-log-updated
                text: The root index.md catalog and log.md were updated to reflect the new page.
              - id: persisted-via-sync
                text: The change was persisted via the sync tool.
                check: { kind: tool, name: sync }
```

- [ ] **Step 5: Create the `lint` scenario** — `eval/scenarios/lint/wiki-health.yaml`:

```yaml
# lint flow — read deterministic health, resolve the dangling link, log the pass.
- config:
    - vars:
        env: wiki
        prompt: |
          Use the open-knowledge-hub MCP tools. Lint my ml-wiki wiki (container "wiki-hub",
          module "wiki"): inspect its health, fix what you safely can, and log the pass. Then sync.
  tests:
    - description: Lint - wiki health - inspects, fixes dangling link, logs
      assert:
        - type: javascript
          value: file://assertions/tools-called.ts
          config: { expect: [inspect, run, sync] }
        - type: javascript
          value: file://assertions/okf-valid.ts
          config: { module: wiki, requireChanged: true }
        - type: javascript
          value: file://assertions/judge.ts
          config:
            criteria:
              - id: inspected-health
                text: The agent ran inspect and used its Wiki health report (orphans / dangling links).
              - id: resolved-dangling
                text: The dangling link to the not-yet-written KV cache page was resolved — either by creating the page or correcting the link.
              - id: logged-pass
                text: A lint entry was appended to log.md describing what was fixed or flagged.
```

- [ ] **Step 6: Validate eval config + types**

Run: `npm run typecheck:eval`
Expected: exit 0.
Run: `npm run test:eval`
Expected: PASS (existing eval tests + any env/scenario structural checks).
Run: `npm run eval:validate`
Expected: config valid.

- [ ] **Step 7: Commit**

```bash
git add eval/fixtures/wiki-hub eval/environments.ts eval/scenarios/write/into-wiki.yaml eval/scenarios/lint/wiki-health.yaml
git commit -m "test(eval): llmwiki fixture, environment, and write/lint scenarios

<trailers>"
```

---

### Task 10: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: exit 0 (needed before the live eval; the harness launches `dist/index.js`).

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Unit tests (full)**

Run: `npm test`
Expected: PASS (all suites). Fix any assertion that hard-codes a type list or rendered prompt text to include `llmwiki`.

- [ ] **Step 4: Eval type-check + tests**

Run: `npm run typecheck:eval && npm run test:eval`
Expected: exit 0 / PASS.

- [ ] **Step 5: Live e2e eval (premium)**

Run: `npm run eval`
Expected: the new `write`/`lint` wiki scenarios pass alongside the existing suite. If a scenario fails, read the failure detail from `~/.promptfoo/promptfoo.db` (latest `evals.id` → `eval_results` where `success=0`) and iterate on the skill text or scenario.

- [ ] **Step 6: Final commit (if verification produced fixes)**

```bash
git add -A
git commit -m "test(llmwiki): fixes from full verification pass

<trailers>"
```

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- §2/§3 OKF substrate + format → Tasks 2–4 (okf helper, loader, skeleton).
- §3.3 links / no-orphan → Task 4 health + Task 6 `write`.
- §3.4 grounding = OKF citation discipline → Task 6 `write`/`lint` (delegate to okf-writer).
- §4 loader + `health` + inspect wiring → Tasks 1, 3, 4, 5.
- §5 skills (initialize/write/lint) + template menu → Task 6.
- §5.4 ask files answers back → Task 7 (ask edit).
- §6.1 ingest routing → Task 7.
- §6.2 ask nav → Task 7. §6.3 add_module (no change) → verified by Task 6 discoverability.
- §6.4 resources → Tasks 3, 6. §6.5 docs → Task 8.
- §7 testing/eval → Tasks 1–9 tests + Task 9 eval + Task 10 full run.

**Placeholder scan** — no TBD/TODO in code steps; the only `TODO` text lives inside the *index-skeleton resource* (intentional author prompts, matching the knowledge skeleton). All code steps show full code.

**Type consistency** — `WikiHealth` fields (`orphans`, `danglingLinks` as `{from,to}`, `uncataloged`, `missingType`) are defined in Task 1 and used identically in Tasks 4 (loader), 5 (service/tools render), and asserted in tests. `okfEnumerate(moduleRoot, defaultType)` signature is consistent across knowledge (`"concept"`) and llmwiki (`"page"`). Skill names `initialize`/`write`/`lint` match across Task 6, the ingest route (Task 7), and the discoverability test.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-10-okh-llmwiki-module-type.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
