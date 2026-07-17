# OKH inspect visibility + ingest efficiency — Implementation Plan

> **Historical note:** Early standalone skill APIs in this record were removed.
> Inspect now nests every runnable skill beneath its concrete module.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `inspect` reveal modules-per-container and each module's scope contract, clarify the ingest/learn disciplines, and add a live eval for ingesting a path into an already-scoped module.

**Architecture:** Two additive fields on `InspectResult` (`containers[].modules`, `module.overview`) filled from data `inspect()` already gathers, printed by `formatInspect`. Discipline edits are resource-only. The eval adds a fixture hub, a workspace-seed environment option, and a scenario.

**Tech Stack:** TypeScript (Node ESM), Zod, Vitest, MCP SDK, promptfoo eval harness, markdown resources.

**Spec:** `docs/superpowers/specs/2026-07-09-okh-inspect-ingest-efficiency-design.md`

---

## File Structure

- `src/container/service.ts` — add `modules` to the containers `InspectResult`; add `overview` to the module `InspectResult`; fill both in `inspect()`.
- `src/server/tools.ts` — `formatInspect` prints module lists + the scope/overview section.
- `resources/module-types/knowledge/skills/learn/SKILL.md` — Stage 1 clarification.
- `resources/shared/skills/ingest/SKILL.md` — Stage 2 + Stage 4 clarifications.
- `test/inspect.test.ts`, `test/server.test.ts` — assert the new inspect output.
- `eval/fixtures/health-hub/health/{.okh/module.yaml,index.md}` — pre-scoped knowledge module.
- `eval/fixtures/health-source/lab-results.txt` — the source to ingest.
- `eval/environments.ts` — optional `workspaceDir`; new `health` env.
- `eval/scenarios/ingest/into-existing-module.yaml` — the scenario.
- `eval-test/environments.test.ts`, `eval-test/okh-eval.test.ts` — env-count + scenario-count updates + a workspaceDir check.

---

## Task 1: Top-level `inspect` lists modules per container

**Files:**
- Modify: `src/container/service.ts` (`InspectResult` containers type ~193-204; `inspect()` no-container branch ~342-354)
- Modify: `src/server/tools.ts` (`formatInspect` containers branch ~55-63)
- Test: `test/inspect.test.ts`, `test/server.test.ts`

- [ ] **Step 1: Write the failing service test**

In `test/inspect.test.ts`, add inside `describe("inspect", …)` (after the "lists containers with no args" test):

```ts
  it("lists each container's modules in the top-level inspect", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await seedModule(dir, "kb", "knowledge", "KB", "team kb");
    const res = await service.inspect();
    expect(res.kind).toBe("containers");
    if (res.kind === "containers") {
      expect(res.containers[0]!.modules).toEqual([{ path: "kb", type: "knowledge", name: "KB" }]);
    }
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/inspect.test.ts -t "lists each container's modules"`
Expected: FAIL — `modules` is `undefined` on the container entry.

- [ ] **Step 3: Add `modules` to the containers InspectResult type**

In `src/container/service.ts`, in the `InspectResult` union's `kind:"containers"` entry, add the
`modules` field:

```ts
      containers: Array<{
        name: string;
        backend: Backend;
        sync?: SyncMode;
        moduleCount: number;
        modules: Array<{ path: string; type: string; name: string }>;
        manifestValid: boolean;
        localPath: string;
      }>;
```

- [ ] **Step 4: Populate `modules` in `inspect()`**

In `src/container/service.ts`, in the no-container branch of `inspect()`, add `modules` to the
mapped object (alongside the existing `moduleCount`):

```ts
          return {
            name: c.name, backend: c.backend, sync: st?.sync ?? c.sync,
            moduleCount: st?.modules.length ?? 0,
            modules: (st?.modules ?? []).map((m) => ({ path: m.path, type: m.type, name: m.name })),
            manifestValid: st?.manifestValid ?? false,
            localPath: c.localPath,
          };
```

- [ ] **Step 5: Run the service test to confirm it passes**

Run: `npx vitest run test/inspect.test.ts -t "lists each container's modules"`
Expected: PASS.

- [ ] **Step 6: Write the failing formatter test**

In `test/server.test.ts`, find the existing test `it("add -> inspect round-trips through the tool interface", …)` (it adds `hub` + a `kb` knowledge module then calls `inspect {}` and asserts the text contains `"hub"`). Add one assertion after the existing `expect(textOf(res)).toContain("hub");`:

```ts
    expect(textOf(res)).toMatch(/knowledge · KB \(kb\)/);
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `npx vitest run test/server.test.ts -t "round-trips"`
Expected: FAIL — the containers listing doesn't yet include module lines.

- [ ] **Step 8: Print modules in `formatInspect` (containers branch)**

In `src/server/tools.ts`, replace the `if (r.kind === "containers") { … }` block with:

```ts
  if (r.kind === "containers") {
    if (r.containers.length === 0) return "No containers registered. Use add_container { source } to register one.";
    return r.containers
      .map((c) => {
        const head =
          `- ${c.name} [${c.backend}] sync=${c.sync ?? "?"} modules=${c.moduleCount}` +
          `${c.manifestValid ? "" : " (invalid manifest)"} — ${c.localPath}`;
        const mods = c.modules.length
          ? c.modules.map((m) => `    · ${m.type} · ${m.name} (${m.path})`).join("\n")
          : "    (no modules)";
        return `${head}\n${mods}`;
      })
      .join("\n");
  }
```

- [ ] **Step 9: Run both tests + typecheck**

Run: `npx vitest run test/server.test.ts -t "round-trips"` — Expected: PASS.
Run: `npm run typecheck` — Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/container/service.ts src/server/tools.ts test/inspect.test.ts test/server.test.ts
git commit -m "feat(inspect): list each container's modules in the top-level listing

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Module `inspect` surfaces the scope contract / overview

**Files:**
- Modify: `src/container/service.ts` (`InspectResult` module type ~206-211; `inspect()` module branch ~360-373)
- Modify: `src/server/tools.ts` (`formatInspect` module branch ~84-91)
- Test: `test/inspect.test.ts`, `test/server.test.ts`

- [ ] **Step 1: Write the failing service test**

In `test/inspect.test.ts`, add inside `describe("inspect", …)`:

```ts
  it("includes the module's overview (index.md scope contract)", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await service.addModule({ container: "hub", path: "kb", type: "knowledge", name: "KB", create: true });
    await writeFile(join(dir, "kb", "index.md"), "# KB\n\n## Goals\n\nKnow the auth system.\n", "utf8");
    const m = await service.inspect("hub", "kb");
    expect(m.kind).toBe("module");
    if (m.kind === "module") expect(m.overview).toContain("Know the auth system.");
  });
```

Add `writeFile` to the node import at the top of the file:

```ts
import { mkdir, rm, writeFile } from "node:fs/promises";
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/inspect.test.ts -t "overview"`
Expected: FAIL — `overview` is `undefined` on the module result.

- [ ] **Step 3: Add `overview` to the module InspectResult type**

In `src/container/service.ts`, in the `InspectResult` union's `kind:"module"` entry, add `overview`:

```ts
  | {
      kind: "module";
      module: { path: string; type: string; name: string; description: string; config?: Record<string, unknown> };
      overview: string;
      items: Item[];
      skills: Array<{ name: string; description: string }>;
    };
```

- [ ] **Step 4: Populate `overview` in `inspect()`**

In `src/container/service.ts`, in the module branch of `inspect()`, compute the overview from the
type loader (every `Loader` implements `overview` per `src/modules/types.ts`) and include it:

```ts
    const manifest = await loadModuleManifest(moduleRoot);
    const items = await this.safeEnumerate(manifest.type, moduleRoot);
    const skills = await this.effectiveSkills(container, module);
    const overview = await getLoader(manifest.type).overview(moduleRoot).catch(() => "");
    return {
      kind: "module",
      module: { path: module, type: manifest.type, name: manifest.name, description: manifest.description, ...(manifest.config ? { config: manifest.config } : {}) },
      overview,
      items,
      skills: skills.map(s => ({ name: s.name, description: s.description })),
    };
```

(`getLoader` is already imported in `service.ts`.)

- [ ] **Step 5: Run the service test to confirm it passes**

Run: `npx vitest run test/inspect.test.ts -t "overview"`
Expected: PASS.

- [ ] **Step 6: Write the failing formatter test**

In `test/server.test.ts`, add a new test after the "add -> inspect round-trips" test:

```ts
  it("module inspect shows the scope contract / overview", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);
    await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add_module", arguments: { container: "hub", path: "kb", type: "knowledge", name: "KB", create: true } });
    const res = await client.callTool({ name: "inspect", arguments: { container: "hub", module: "kb" } });
    expect(textOf(res)).toContain("Scope / overview:");
    expect(textOf(res)).toMatch(/okf_version|Knowledge module/);
  });
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `npx vitest run test/server.test.ts -t "scope contract"`
Expected: FAIL — no `Scope / overview:` section yet.

- [ ] **Step 8: Print the overview in `formatInspect` (module branch)**

In `src/server/tools.ts`, replace the module branch (the block starting `const head = \`Module …`
through the final `return [head, ...items, "Skills:", ...skillLines].join("\n");`) with:

```ts
  const head = `Module ${r.module.path} [${r.module.type}] ${r.module.name}${r.module.description ? ` — ${r.module.description}` : ""} — ${r.items.length} items`;
  const items = r.items.length
    ? r.items.map((i) => `  - ${i.title}${i.description ? ` — ${i.description}` : ""} (${i.path})`)
    : ["  (empty)"];
  const skillLines = r.skills.length
    ? r.skills.map((s) => `  - ${s.name} — ${s.description}`)
    : ["  (none)"];
  const overview = r.overview.trim();
  const overviewLines = overview
    ? ["Scope / overview:", ...overview.split("\n").map((l) => `  ${l}`)]
    : ["Scope / overview:", "  (no overview)"];
  return [head, ...items, "Skills:", ...skillLines, ...overviewLines].join("\n");
```

- [ ] **Step 9: Run tests + typecheck**

Run: `npx vitest run test/server.test.ts -t "scope contract" test/inspect.test.ts` — Expected: PASS.
Run: `npm run typecheck` — Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/container/service.ts src/server/tools.ts test/inspect.test.ts test/server.test.ts
git commit -m "feat(inspect): surface a module's scope contract / overview

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Discipline clarifications (learn + ingest)

**Files:**
- Modify: `resources/module-types/knowledge/skills/learn/SKILL.md` (Stage 1, line ~10)
- Modify: `resources/shared/skills/ingest/SKILL.md` (Stage 2 + Stage 4)

- [ ] **Step 1: Clarify learn Stage 1**

In `resources/module-types/knowledge/skills/learn/SKILL.md`, replace the Stage 1 paragraph:

```markdown
Read the module's `index.md` and recover its **scope contract**: the **goals**, the **target questions**, and the **out-of-scope** list. Restate it back to the user in one or two lines. If there is no written scope contract, stop and reconstruct one first — you cannot judge "worth remembering" without it.
```

with:

```markdown
Read the module's `index.md` and recover its **scope contract**: the **goals**, the **requirements / target questions**, and the **out-of-scope** list. Restate it back to the user in one or two lines. A module with **0 concepts can still have a full scope contract** in `index.md` — do not treat an empty concept list as "uninitialized", and do not run `initialize` on a module that already has a contract. Only if there is genuinely no written scope contract, stop and reconstruct one first — you cannot judge "worth remembering" without it.
```

- [ ] **Step 2: Clarify ingest Stage 2 (extraction hint)**

In `resources/shared/skills/ingest/SKILL.md`, replace the Stage 2 body paragraph:

```markdown
For each source, obtain its **text** with your own tools: PDF/doc/image → text, using OCR or table
extraction when the document is scanned or tabular. If a source **can't be read or extracted**, do
not invent its contents — list it as a failure and ask how to proceed.
```

with:

```markdown
For each source, obtain its **text** with your own tools — prefer a local extractor (a small PDF
library, or `pdftotext`); use OCR or table extraction only for scanned or image pages. If a source
**can't be read or extracted**, do not invent its contents — list it as a failure and ask how to
proceed.
```

- [ ] **Step 3: Clarify ingest Stage 4 (don't re-initialize)**

In `resources/shared/skills/ingest/SKILL.md`, at the end of the Stage 4 paragraph that begins
"Before writing in bulk, present a short **routing plan**…", append this sentence (immediately
before the blank line that precedes `## Stage 5 — Report`):

```markdown
 If the target module already has a scope contract in `index.md`, do **not** re-initialize it — `learn` reads the existing contract; a module with zero concepts is not the same as an uninitialized one.
```

- [ ] **Step 4: Verify skills still parse**

Run: `npx vitest run test/run.test.ts test/inspect.test.ts`
Expected: PASS (skill discovery reads frontmatter; bodies changed only).

- [ ] **Step 5: Commit**

```bash
git add resources/module-types/knowledge/skills/learn/SKILL.md resources/shared/skills/ingest/SKILL.md
git commit -m "docs(skills): 0 concepts != uninitialized; ingest extraction hint + no re-initialize

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Eval fixture + workspace-seed environment + scenario

**Files:**
- Create: `eval/fixtures/health-hub/health/.okh/module.yaml`
- Create: `eval/fixtures/health-hub/health/index.md`
- Create: `eval/fixtures/health-source/lab-results.txt`
- Modify: `eval/environments.ts`
- Create: `eval/scenarios/ingest/into-existing-module.yaml`
- Test: `eval-test/environments.test.ts`, `eval-test/okh-eval.test.ts`

- [ ] **Step 1: Create the module manifest**

Create `eval/fixtures/health-hub/health/.okh/module.yaml`:

```yaml
type: knowledge
name: Health
description: David's personal health knowledge — conditions, history, and lab results.
```

- [ ] **Step 2: Create the pre-filled scope contract**

Create `eval/fixtures/health-hub/health/index.md`:

```markdown
---
okf_version: "0.1"
---

# Health

> **Purpose:** David's personal health knowledge — conditions, medical history, and lab results.

## Goals

Track David's own health: conditions and their status, a medical-history timeline, and
longitudinal lab/bloodwork results, plus reference notes that help interpret them.

## Requirements

- Record and look up **conditions** (diagnosis, status, notes).
- Maintain a **medical history** timeline (events, procedures, dates).
- Record **lab results / bloodwork trends** (panel, analyte, value, unit, date) with reference ranges.
- Store **reference** notes that help interpret the above.

**Out of scope:** appointment scheduling, medication management, fitness/nutrition/sleep tracking.

## Structure

- **Folders / groups** — flat for now; concepts live at the module root, grouped later as topics settle.
- **Concept types** — `condition`, `history-event`, `lab-result`, `reference`.
- **Tags** — optional, e.g. the analyte or panel name.
- **Cross-linking** — bundle-relative links between related concepts.

## Concepts

_None yet._
```

- [ ] **Step 3: Create the source file**

Create `eval/fixtures/health-source/lab-results.txt`:

```text
Result Trends — LIPID PANEL — David — Jul 9, 2026

Analyte             Jul 9 2026    Jan 3 2025    Reference range
Total Cholesterol   188 mg/dL     205 mg/dL     < 200 mg/dL
LDL Cholesterol     108 mg/dL     130 mg/dL     < 100 mg/dL
HDL Cholesterol      55 mg/dL      48 mg/dL     > 40 mg/dL
Triglycerides       120 mg/dL     150 mg/dL     < 150 mg/dL
```

- [ ] **Step 4: Add `workspaceDir` to the Environment interface + provisioning**

In `eval/environments.ts`, add the optional field to the `Environment` interface:

```ts
export interface Environment {
  placement: "registered" | "workspace";
  hubs: EnvHub[];
  workspaceDir?: string;
}
```

Then in `provisionEnvironment`, after the `if (def.placement === "workspace") { … } else { … }`
block (right before `await writeMcpConfig(…)`), add:

```ts
  if (def.workspaceDir) {
    await cp(fixturePath(def.workspaceDir), workspace, { recursive: true });
  }
```

- [ ] **Step 5: Add the `health` environment**

In `eval/environments.ts`, add to the `environments` object (after `custom`):

```ts
  health: {
    placement: "registered",
    hubs: [{ container: "health-hub", fixture: "fixtures/health-hub", backend: "local" }],
    workspaceDir: "fixtures/health-source",
  },
```

- [ ] **Step 6: Create the scenario**

Create `eval/scenarios/ingest/into-existing-module.yaml`:

```yaml
# ingest flow — a path source into an EXISTING, already-scoped knowledge module.
# Captures the efficient path: resolve the module, read its scope contract, write a
# cited concept, without re-initializing.
- config:
    - vars:
        env: health
        prompt: |
          hub, ingest ./lab-results.txt into my Health module.
  tests:
    - description: Ingest - existing scoped module - path source, no re-initialize
      assert:
        - type: javascript
          value: file://assertions/tools-called.ts
          config: { expect: [inspect, run] }
        - type: javascript
          value: file://assertions/judge.ts
          config:
            criteria:
              - id: resolved-module
                text: The agent located the existing Health knowledge module (in health-hub) to ingest into.
              - id: read-scope-contract
                text: The agent read or acknowledged the module's existing scope contract before writing, rather than treating the module as uninitialized.
              - id: no-reinitialize
                text: The agent did NOT run the initialize skill on the already-scoped module.
              - id: wrote-cited-concept
                text: The agent added at least one concept sourced from lab-results.txt, citing the source file.
```

- [ ] **Step 7: Update the environment-count test**

In `eval-test/environments.test.ts`, update the count assertion (line ~15):

```ts
    expect(Object.keys(environments).sort()).toEqual(["custom", "empty", "git", "health", "local-and-git"]);
```

Add a provisioning test after the "empty leaves an empty registry…" test:

```ts
  it("health seeds the source file into the workspace and registers health-hub", async () => {
    const prov = await provisionEnvironment("health", { repoRoot: "C:/repo", runner: testRun });
    cleanups.push(prov.root);
    expect(await exists(join(prov.workspace, "lab-results.txt"))).toBe(true);
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    expect(reg.containers[0].name).toBe("health-hub");
  });
```

- [ ] **Step 8: Update the okh-eval env-count + scenario-count tests**

In `eval-test/okh-eval.test.ts`, update the env list (line ~15):

```ts
    expect(listEnvironments().sort()).toEqual(["custom", "empty", "git", "health", "local-and-git"]);
```

and the scenario count (line ~20):

```ts
    expect(all.length).toBe(21);
```

- [ ] **Step 9: Run eval-suite checks**

Run: `npm run typecheck:eval` — Expected: exit 0.
Run: `npm run test:eval` — Expected: PASS (env test now expects 5; the new health-provision test passes; scenario count 21).
Run: `npm run eval:validate` — Expected: prints "Configuration is valid."

- [ ] **Step 10: Commit**

```bash
git add eval/fixtures/health-hub eval/fixtures/health-source eval/environments.ts eval/scenarios/ingest/into-existing-module.yaml eval-test/environments.test.ts eval-test/okh-eval.test.ts
git commit -m "test(eval): ingest-into-existing-module scenario with a workspace-seeded source

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + full unit suite**

Run: `npm run typecheck && npm test`
Expected: exit 0; all tests pass (inspect/server updates + everything else).

- [ ] **Step 2: Eval structure checks**

Run: `npm run typecheck:eval && npm run test:eval && npm run eval:validate`
Expected: typecheck exit 0; eval unit tests pass; validate prints "Configuration is valid."

- [ ] **Step 3: Build (the e2e harness launches dist/index.js)**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Run the new ingest scenario end-to-end**

Run: `node --import tsx node_modules/promptfoo/dist/src/entrypoint.js eval -c eval/promptfooconfig.yaml --no-cache --filter-pattern "existing scoped module"`
Expected: 1 passed. The agent resolves the Health module in one inspect, reads the scope contract,
and writes a cited concept without re-initializing. If it fails on a judge criterion, inspect the
transcript via `~/.promptfoo/promptfoo.db` and adjust wording only if the behavior is actually
correct but phrased differently.

- [ ] **Step 5: Full e2e eval (regression sweep)**

Run: `npm run eval`
Expected: no new failures versus baseline (the onboard/ask/etc. scenarios still pass; the new
ingest scenario passes). Treat a lone flaky judge failure as flaky only after a green re-run of
that single scenario.

---

## Self-Review notes

- **Spec coverage:** §2a top-level modules (T1), §2b module overview (T2), §2c formatting (T1+T2),
  §3 disciplines (T3), §4 unit tests (T1+T2), §5 fixture/env/scenario (T4), §6 verification (T5).
- **No placeholders:** all code, fixture content, and doc edits are shown verbatim; commands have
  expected output.
- **Type consistency:** `modules: { path, type, name }[]` and `overview: string` are defined in T1/T2
  and matched by the formatter and tests; `getLoader(type).overview` matches the required `Loader`
  method (`src/modules/types.ts`).
- **Eval-test counts:** env count 4→5 and scenario count 20→21 are updated in T4; `config.test.ts`
  validates each scenario's `env` against `environments` automatically (no edit needed once `health`
  exists).
