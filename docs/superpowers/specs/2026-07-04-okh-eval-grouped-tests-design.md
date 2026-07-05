# OKH eval: grouped test files + environment-centric manual mode

Date: 2026-07-04
Status: Approved (design) — pending spec review

## Problem

Each scenario is its own folder `scenarios/<verb>/<case>/` with a `test.yaml` (that
references a separate `prompt.md` via a `file://` var) and a one-word-with-dashes
`description` that doubles as the id the manual harness selects by. We want: (1) prompts
embedded in the test file, (2) related tests combined into one file with multiple tests,
(3) descriptive sentence descriptions. And the manual harness should be **environment-
centric** — you provision an environment, and it prints that environment's test prompts
for you to run and eyeball, rather than selecting a single scenario by id.

## Decisions (from brainstorming)

- **7 grouped test files** (one per verb, onboard split by flavor); no more per-scenario
  folders.
- **Prompts inline** in each test's `vars.prompt` (multiline); all `prompt.md` deleted.
- **No per-test id.** `description` is a descriptive sentence (shown in the promptfoo
  viewer). Nothing selects a test by id anymore.
- **Manual mode is environment-centric.** `setup <env>` provisions an environment and
  prints the list of test prompts (+ expected-outcome checklists) for that environment.
  The per-scenario `check` command is **removed** (manual verification is by eye; the
  deterministic assertions still run in the automated `npm run eval`).

## File layout (7 files, 16 tests)

| file | tests (by description intent) | env |
|------|------|-----|
| `scenarios/ask.yaml` (3) | grounded, declines-when-absent, multi-container | local-and-git |
| `scenarios/context.yaml` (2) | assembly, includes-skills-tools | local-and-git |
| `scenarios/learn.yaml` (2) | integrates (git), rejects-trivial (local-and-git) | mixed |
| `scenarios/remember.yaml` (2) | records, no-conclusions | local-and-git |
| `scenarios/reflect.yaml` (1) | insights | local-and-git |
| `scenarios/onboard-getting-started.yaml` (3) | explains, phrase, wake-phrase | empty |
| `scenarios/onboard-add-create.yaml` (3) | create-local, add-existing-folder, add-github | empty |

The old `scenarios/<verb>/<case>/` folders and all `prompt.md` files are deleted.

## Per-test shape

```yaml
# scenarios/ask.yaml — a YAML list of tests
- description: Answers strictly from the container's knowledge module, citing the source
  vars:
    env: local-and-git
    prompt: |
      Use the open-knowledge-hub MCP tools. In container "kb-hub", answer strictly
      from its knowledge module: How does auth work?
  assert:
    - { type: javascript, value: file://assertions/tools-called.ts, config: { expect: [ask] } }
    - { type: javascript, value: file://assertions/transcript.ts, config: { mustContain: ["token"] } }
    - type: javascript
      value: file://assertions/judge.ts
      config:
        criteria: [ ... ]   # unchanged from today
```

- No `metadata.id`, no `prompt.md`. `vars` has exactly `{ env, prompt }`.
- `assert` blocks are copied verbatim from today's scenarios (including
  `assert.config.name` container names).

### Descriptions (verbatim, replacing the dashed ids)

| current id | new `description` |
|------------|-------------------|
| ask-grounded | Answers strictly from the container's knowledge module, citing the source |
| ask-declines-when-absent | Declines when the knowledge base lacks the information, without fabricating |
| ask-multi-container | Answers across all registered hubs, citing each fact's module path |
| context-assembly | Assembles a compact working set for a task, citing module paths and noting gaps |
| context-includes-skills-tools | Includes relevant skills and tools in the working set, not just knowledge |
| learn-integrates | Integrates a new fact as an OKF concept and persists it via sync |
| learn-rejects-trivial | Rejects a trivial, goal-less fact instead of writing it to the module |
| remember-records | Records a raw, timestamped observation as an append-only memory entry |
| remember-no-conclusions | Stores the raw result without synthesizing conclusions or recommendations |
| reflect-insights | Reflects across memory entries to surface a recurring pattern and propose an update |
| onboard-explains | Explains what OKH is and how to set up a first hub |
| onboard-phrase | Begins guided onboarding when asked via the cold-start phrase |
| onboard-wake-phrase | Sets a custom wake phrase during onboarding |
| onboard-create-local | Creates a new local hub with a knowledge module after previewing the plan |
| onboard-add-existing-folder | Registers an existing local folder as a hub after previewing |
| onboard-add-github | Clones and registers a GitHub repo as a git hub, then summarizes its content |

## promptfoo config

`tests: file://scenarios/*.yaml` (was `scenarios/*/*/test.yaml`). The single `{{prompt}}`
pass-through prompt and the provider are unchanged. Result: 16 tests, dense 16×1 grid,
each row named by its descriptive `description`.

## Manual harness (`okh-eval.ts`) — environment-centric

New surface (replaces the scenario-centric commands):

- `npm run eval:setup -- list` → lists the environments (`empty`, `git`, `local-and-git`)
  with how many test prompts each has.
- `npm run eval:setup -- setup <env>` → provisions that environment via
  `provisionEnvironment(env, …)`, records the run (keyed by env), and prints:
  - the Root/Workspace paths, the `enter` and `clean` commands, and
  - **for each test whose `vars.env === <env>`**: its `description`, the full prompt text
    (to paste), and its expected-outcome checklist (the `assert` summary, as today).
- `npm run eval:setup -- enter [env]` → interactive Copilot session in the provisioned env
  (most-recent run, or the named env).
- `npm run eval:setup -- clean [env]` → remove the run.
- **Removed:** the `check` command, `runChecks`, `SIDE_EFFECT_ASSERTIONS`, and the
  now-unused `loadRegistry`/`findContainer` imports. (The assertion modules themselves stay
  — they're used by the automated `npm run eval`.)

Harness internals:
- `ScenarioTest` = `{ description: string; vars: { env: EnvName; prompt: string }; assert: … }`.
- `loadScenarios()` reads every `scenarios/*.yaml`, flattens the lists (prompt is inline —
  no `prompt.md` read). `scenariosForEnv(env)` filters by `vars.env`.
- `listEnvironments()` = `Object.keys(environments)`.
- `setupEnvironment(env, { model? })` provisions + returns `{ root, workspace, copilotHome,
  command, prompts: Array<{ description, prompt, checklist }> }`.

## run-state.ts

`RunRecord` becomes `{ env: EnvName; root; workspace; copilotHome; createdAt }` (drop
`scenario` and `backend`). `recordRun` upserts by `env`; `resolveRun(env?)` resolves by env
or most-recent. Update the guidance strings to `setup <env>`.

## Provider

Temp-dir label ← `vars.env` (was `context.test.description`, which is now a long
sentence). One line in `copilotProvider.ts`.

## Files to change

- **Create** 7 `scenarios/*.yaml` (grouped tests, inline prompts, descriptions).
- **Delete** the 16 `scenarios/<verb>/<case>/` folders (incl. all `test.yaml` + `prompt.md`).
- **Modify** `eval/promptfooconfig.yaml` (tests glob).
- **Modify** `eval/provider/copilotProvider.ts` (label ← `vars.env`).
- **Rewrite** `eval/okh-eval.ts` (env-centric; drop check/runChecks).
- **Modify** `eval/run-state.ts` (scenario→env; drop backend).
- **Modify** `eval-test/config.test.ts` (new discovery: 7 files, per-file counts, total 16;
  each test has a descriptive `description` (non-empty, contains a space), inline
  `vars.prompt`, and a valid `env`).
- **Rewrite** `eval-test/okh-eval.test.ts` (env-centric API) and update
  `eval-test/run-state.test.ts` (env-keyed records).
- **Modify** `eval/README.md` (manual section → env-centric `list`/`setup <env>`/`enter`/
  `clean`; note check removed).

## Verification

- `npm run eval:validate` (valid) · `npm run typecheck:eval` · `npm run test:eval`.
- Offline `echo` run over `scenarios/*.yaml`: 16 results, one dense prompt column, 3
  distinct `env` values.
- Larger change → full live `npm run eval` must stay **16/16**; viewer grid shows 16 rows
  named by their descriptions, 0 null cells.
- Manual smoke: `npm run eval:setup -- setup local-and-git` prints the env's prompts +
  checklists; `enter` opens a session; `clean` removes it.
