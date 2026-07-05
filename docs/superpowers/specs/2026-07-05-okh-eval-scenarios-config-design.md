# OKH eval: single scenarios-based promptfooconfig.yaml

Date: 2026-07-05
Status: Approved (design)

## Problem

Each eval test case is currently a **standalone** promptfoo config
(`eval/scenarios/<verb>/<case>.yaml`) with its own `providers`, inline `prompts`, and a
single `tests` entry. `run-scenarios.ts` runs **one `promptfoo` process per file**
(recursing `scenarios/`, skipping `shared/`) purely to dodge promptfoo's prompt×test
cross-product. There is no central config. The user wants a single default
`promptfooconfig.yaml` that pulls every case in via promptfoo's native **scenarios**
feature, and `npm run eval` to load that default.

## Constraints (promptfoo scenarios)

- A `scenarios` entry pairs `config` (an array of `vars` sets) with `tests` (asserts run
  on each set), producing a `config × tests` matrix. With **one config set + one test**
  per scenario, each scenario is exactly one eval row — no cross-product.
- Scenario files can be loaded with `file://` **glob** patterns; matched files are
  flattened into one array, so each file must be a **YAML list of scenarios**.
- A single top-level prompt template `{{prompt}}` fed by a per-scenario `vars.prompt`
  gives one prompt × N scenarios (no prompt fan-out), replacing the per-file runner.

## Decision

Consolidate into **one `eval/promptfooconfig.yaml`** that globs
`scenarios/**/*.yaml` as scenarios, with a single `{{prompt}}` pass-through prompt and the
shared provider referenced once at top level. Keep the per-verb folder layout (least
disruption); convert each existing standalone config into a one-element scenario list.
Run the whole suite in **one** promptfoo process with promptfoo's default concurrency
(4 workers).

## Design

### 1. `eval/promptfooconfig.yaml` (new default)

```yaml
description: OKH E2E eval (Copilot CLI)
prompts:
  - "{{prompt}}"
providers:
  - file://scenarios/shared/provider.ts
scenarios:
  - file://scenarios/**/*.yaml
```

`providers`/`prompts` live here **once**. `scenarios/shared/` is excluded by the glob
(it holds `provider.ts`, not a `*.yaml`).

### 2. Scenario files (`scenarios/<verb>/<case>.yaml`)

Each becomes a **one-element list**: move the inline prompt into `config.vars.prompt`,
move `env` alongside it, keep the asserts under `tests[0].assert`. Drop the per-file
`providers` and top-level `prompts`.

```yaml
# ask flow — answer strictly from a container's knowledge module.
- description: Ask - answerable question - grounded answer, cites source
  config:
    - vars:
        env: local-and-git
        prompt: |
          Use the open-knowledge-hub MCP tools. In container "kb-hub", answer strictly
          from its knowledge module: How does auth work?
  tests:
    - assert:
        - { type: javascript, value: file://../../assertions/tools-called.ts, config: { expect: [ask] } }
        - { type: javascript, value: file://../../assertions/transcript.ts, config: { mustContain: ["token"] } }
        - type: javascript
          value: file://../../assertions/judge.ts
          config: { criteria: [ ... unchanged ... ] }
```

`description` names the row in the viewer. All 16 files convert identically; assert bodies
are unchanged.

### 3. `file://` path resolution (verify during impl)

Asserts inside scenario files use `../../assertions/…`. promptfoo may resolve these
relative to (a) the scenario file, or (b) the base `promptfooconfig.yaml`. Confirm with a
`validate`/offline run:
- If (a): paths stay `../../assertions/…` and provider stays `file://scenarios/shared/provider.ts` at top level.
- If (b): rewrite assert paths to `file://assertions/…` (relative to `eval/`).

Pick whichever validates; document it.

### 4. `run-scenarios.ts` (simplified)

Drop the recursive per-file loop and the `configFiles()` walk. Run a **single**
`promptfoo eval|validate -c eval/promptfooconfig.yaml` through `node --import tsx`
(needed for the TS provider/assertions) with `--no-cache` on `eval`. Preserve the
`eval | validate` mode arg, so `npm run eval` and `npm run eval:validate` keep their
current signatures. Concurrency = promptfoo default (no `--max-concurrency` flag).

### 5. Manual harness (`okh-eval.ts`) — must follow the new shape

`loadScenarios()` currently reads `cfg.prompts[0]` and `cfg.tests[0].vars.env` /
`cfg.tests[0].assert` from each standalone config. Since each file is now a **list** of
scenarios, update it to read from the scenario shape: iterate the array, and for each
scenario take `description`, `config[0].vars.prompt`, `config[0].vars.env`, and
`tests[0].assert`. The `ScenarioTest` fields (`file`, `description`, `env`, `prompt`,
`assert`) and every downstream consumer (`scenariosForEnv`, `setupEnvironment`, CLI
output) stay the same.

### 6. Unit tests

- `eval-test/config.test.ts`: rewrite `scenarioFiles` assertions to validate the new
  shape — each file parses to a **one-element array**; the element has `description`
  (unique sentence), `config[0].vars.{prompt,env}` (env in `environments`, prompt a
  non-empty bare string without `{{prompt}}`), and `tests[0].assert` with judge criteria
  and existing assertions. Provider/prompt are no longer per-file, so drop those checks
  (or assert their **absence**); add a check that top-level `promptfooconfig.yaml` has the
  `{{prompt}}` prompt, the shared provider, and the scenarios glob. Keep the "16 cases
  across the expected verb folders" count.
- `eval-test/okh-eval.test.ts`: unchanged expectations (16 scenarios, per-env counts
  9/1/6, prompt/env present) — verifies the updated `loadScenarios` still yields the same
  normalized data.

### 7. Docs

Update `eval/README.md`: replace the "one complete config per file / one process per file"
narrative in **How test cases work** and **Running automatically** with the scenarios
model (one config, `{{prompt}}` pass-through, glob of scenario files, concurrent run,
single eval record in the viewer). Keep the environments/assertions/judge sections.

### 8. Unchanged / out of scope

`shared/provider.ts`, `provider/copilotProvider.ts`, `environments.ts`, all
`assertions/*.ts`, the judge, and fixtures are untouched. No changes to which env each
case uses or to assert configs.

## Verification

- `npm run eval:validate` → `Configuration is valid.` (single config).
- `npm run typecheck:eval`, `npm run test:eval` green after the `config.test.ts`
  rewrite and `okh-eval.ts` `loadScenarios` update.
- `npm run eval:view` shows all 16 cases as rows in **one** eval record.
- Larger change → full live `npm run eval` (expect 16/16) per completion criteria, after
  `npm run build`.
