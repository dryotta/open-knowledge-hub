# OKH — `inspect` visibility + ingest efficiency

**Status:** Approved design (pre-implementation)
**Date:** 2026-07-09
**Branch:** `feat/inspect-ingest-efficiency`
**Relates to:** the `ingest`/`learn`/`initialize` skills, `inspect` tool.

---

## 1. Summary

A real ingest run into a freshly-scoped `health` module wasted several agent iterations. Two are
**product data gaps in `inspect`**; the rest are discipline nits. This change closes the gaps,
clarifies the disciplines, and adds an eval that exercises "ingest a path into an existing,
already-scoped module."

### Observed waste (from the session transcript)

1. **Finding the module (~40s):** the user named "health," but the agent had to `inspect` *each*
   container to locate it — the top-level `inspect` reports only a module **count** per container,
   not names.
2. **"Empty → no scope contract" false alarm:** `inspect` reported the module as "0 items," so the
   agent concluded there was no scope contract and started fetching the `initialize` discipline —
   then found `index.md` already held the contract. `inspect` never surfaces the scope contract.
3. **`okf-writer` called as a module skill first** (it's shared) — minor.
4. **"Check for a PDF tool first" detour** before extracting — the `ingest` skill gives no
   extraction hint.

### Goals

1. A named module is locatable in **one** `inspect` call.
2. `inspect` on a module surfaces its **scope contract**, so "0 concepts" is never read as
   "uninitialized."
3. Disciplines steer agents away from the two churny mistakes (re-initializing an already-scoped
   module; hunting for a PDF tool).
4. An eval captures the efficient end-to-end behavior of ingesting a path into an existing module.

### Non-goals

- Measuring literal iteration counts (not expressible in promptfoo).
- Delivering real PDF attachments in the harness (use a seeded text file).
- Cross-container module-name *search* as a new argument shape (the enriched top-level listing
  already solves the lookup); `inspect`'s `{ container, module }` contract is unchanged.
- Any change to `learn`/`initialize`/`ingest` *routing* (only wording clarifications).

---

## 2. `inspect` code changes

### 2a. Top-level listing includes modules — `src/container/service.ts`

`InspectResult` `kind:"containers"` entries gain a `modules` summary:

```ts
containers: Array<{
  name: string;
  backend: Backend;
  sync?: SyncMode;
  moduleCount: number;
  modules: Array<{ path: string; type: string; name: string }>; // NEW
  manifestValid: boolean;
  localPath: string;
}>;
```

`inspect()` (no-container branch) fills `modules` from the same `status(c.name)` it already fetches
(`ContainerStatus.modules` has `path`/`type`/`name`). `moduleCount` stays (== `modules.length`).

### 2b. Module inspect includes the scope contract / overview — `src/container/service.ts`

`InspectResult` `kind:"module"` gains `overview: string`:

```ts
| {
    kind: "module";
    module: { path: string; type: string; name: string; description: string; config?: Record<string, unknown> };
    overview: string; // NEW — the module's entry text (knowledge: index.md scope contract)
    items: Item[];
    skills: Array<{ name: string; description: string }>;
  };
```

The module branch of `inspect()` calls the type loader's `overview(moduleRoot)`
(`getLoader(manifest.type).overview` — every loader implements it per `Loader` in
`src/modules/types.ts`) and includes the result. Guard with a `.catch(() => "")` so a read error
never breaks inspect.

### 2c. Formatting — `src/server/tools.ts` `formatInspect`

- **containers branch:** after each container line, list its modules indented, e.g.
  `    · knowledge · Health (health)`; show `(no modules)` when empty.
- **module branch:** after the header/items/skills, append a `Scope / overview:` section with the
  `overview` text (trimmed). When `overview` is empty, print `  (no overview)`.

No schema/handler-arg change; `inspect` still takes `{ container?, module? }`.

---

## 3. Discipline clarifications (resources)

- **`resources/module-types/knowledge/skills/learn/SKILL.md`, Stage 1:** add a sentence — "A module
  with **0 concepts can still have a full scope contract** in `index.md`. Read `index.md`; do not
  treat an empty concept list as 'uninitialized', and do not run `initialize` on a module that
  already has a scope contract."
- **`resources/shared/skills/ingest/SKILL.md`:**
  - Stage 2 (Extract): add a concrete hint — "prefer a local text extractor (e.g. a small Python
    PDF library, or `pdftotext`); OCR only for scanned/image pages. Check the target module's
    `index.md` scope contract before extracting in bulk."
  - Stage 4 (Route): add — "If the target module already has a scope contract, do **not**
    re-initialize it; `learn` reads the existing contract."

---

## 4. Unit tests (deterministic capture of §2)

- **`test/inspect.test.ts`:** after adding a `knowledge` module with a written `index.md` scope
  contract, assert the **module inspect** result carries `overview` containing the contract text,
  and that top-level **containers inspect** lists the module by name.
- **`test/server.test.ts`:** assert the tool-level `inspect` (no args) output text lists a module
  name under its container, and that `inspect { container, module }` output text contains the
  scope-contract line (`Scope / overview`).

These fail before §2 and pass after — the concrete capture of the product fix.

---

## 5. Eval scenario (end-to-end capture)

### 5a. Fixture — `eval/fixtures/health-hub/`

Mirror the `kb-hub` layout for one knowledge module:

```
health-hub/
  health/
    .okh/module.yaml        # type: knowledge, name: Health, description: Personal health knowledge
    index.md                # a FILLED scope contract whose Requirements include lab/bloodwork results
```

`index.md` scope contract explicitly puts **lab results / bloodwork trends** *in scope* (so the
efficient path is: read contract → in scope → write concept, with no scope-negotiation detour).

### 5b. Environment enhancement — `eval/environments.ts`

Add an optional workspace-seed to `Environment`:

```ts
export interface Environment {
  placement: "registered" | "workspace";
  hubs: EnvHub[];
  workspaceDir?: string; // NEW — a fixture dir copied into the run's workspace (cwd)
}
```

`provisionEnvironment` copies `workspaceDir` (when set) into `workspace` after placing hubs. Add a
`health` env:

```ts
health: {
  placement: "registered",
  hubs: [{ container: "health-hub", fixture: "fixtures/health-hub", backend: "local" }],
  workspaceDir: "fixtures/health-source",
},
```

New fixture `eval/fixtures/health-source/lab-results.txt` — a small, plain-text lab panel (e.g. a
lipid panel with a few dated values) the agent can read at `./lab-results.txt` (cwd == workspace).

### 5c. Scenario — `eval/scenarios/ingest/into-existing-module.yaml`

```yaml
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
                text: The agent read/acknowledged the module's existing scope contract before writing, rather than treating the module as uninitialized.
              - id: no-reinitialize
                text: The agent did NOT run the initialize skill on the already-scoped module.
              - id: wrote-cited-concept
                text: The agent added at least one concept sourced from lab-results.txt, citing the source file.
```

The eval provisions a fresh home with no wake phrase set, so the default `hub` routes to the OKH
tools (matching the other scenarios' phrasing).

---

## 6. Verification

- **Unit:** `npm run typecheck` + `npm test` — new inspect assertions pass; existing inspect/server
  tests updated for the enriched output; `add-confirm`/`service` unaffected.
- **Eval structure:** `npm run typecheck:eval`, `npm run test:eval`, `npm run eval:validate`
  (new env + scenario parse; `test:eval` covers `provisionEnvironment` with `workspaceDir`).
- **Full e2e eval:** `npm run build && npm run eval` — the new ingest scenario runs; confirm the
  agent resolves the module in one inspect, reads the contract, and writes a cited concept without
  re-initializing.

---

## 7. Risks & mitigations

- **Enriched inspect output breaks existing text assertions** → update the two affected server/inspect
  tests; the format additions are additive (module lines / a Scope section).
- **`overview` too large in inspect** → knowledge `index.md` is the scope contract (small by design);
  print it trimmed. No cap needed now; revisit if a loader's overview is huge.
- **Eval wake-phrase routing** → use the harness's reliable default (verified during implementation);
  the assertion set already tolerates the two-call ingest→learn flow (`run` covers both).
- **Workspace-seed env change** → additive optional field; existing envs (no `workspaceDir`)
  behave exactly as before; `test:eval` provisions the new env to prove it.

## 8. Out of scope / deferred

- A dedicated cross-container module *search* argument.
- PDF/attachment handling in the harness.
- Any change to sync/config/add tools.
