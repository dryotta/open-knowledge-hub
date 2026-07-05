# OKH eval: environment abstraction + test-case cleanup

Date: 2026-07-04
Status: Approved (design) — pending spec review

## Problem

Each `test.yaml` carries 6–8 provisioning vars (`scenario`, `backend`, `container`,
`fixture`, `provision`, `container2`, `fixture2`). Most describe **environment setup**,
not the test's intent, and duplicate across scenarios. Goal: collapse the setup vars into
a single `env` var backed by a central environment definition, drop the redundant
`scenario` var, and clean up anything no longer needed.

## Decisions (from brainstorming)

- **`environments.ts` replaces `provision.ts` entirely.** One module both *defines* the
  environments and *materializes* them (`provisionEnvironment()`), absorbing all of
  `provision.ts`'s filesystem/git/mcp-config logic. `eval/provision.ts` is **deleted**.
- **No provisioning "mode" enum.** The old `registered` / `empty` / `unregistered-local`
  triad is gone; provisioning is derived directly from each environment's definition
  (`placement` + `hubs`). The formerly-separate (and now unused) pure-`empty` mode simply
  ceases to exist.
- **`scenario` var removed.** It only prefixed the temp dir. promptfoo passes
  `context.test.description` (= the scenario id) to the provider, and the manual harness
  already derives the id from the folder path. The temp-dir label comes from `description`.
- **A capability-based 3-environment model.** Minimal per-scenario isolation is explicitly
  **not** a goal; fewer consolidated environments is the priority. Validated by the full
  live eval; if a scenario regresses, adjust the scenario/prompt/shared env — **do not**
  add another environment.

## Environments (`eval/environments.ts`)

The module exports the typed env map **and** the provisioning function. `provision.ts` is
deleted; its `EvalBackend` / `Provisioned` types and its logic move here.

```ts
export type EvalBackend = "local" | "git-auto";
export interface EnvHub {
  container: string;
  fixture: string;            // path relative to eval/
  backend?: EvalBackend;      // default "local"
}
export interface Environment {
  /** "registered" adds hubs to the OKH registry; "workspace" drops them as
      UNREGISTERED folders in the working dir (empty registry). */
  placement: "registered" | "workspace";
  hubs: EnvHub[];             // hubs[0] = primary (drives metadata.containerPath/originPath)
}
export const environments = {
  // Empty registry + one UNREGISTERED folder in the workspace. Serves add-existing-folder,
  // add-from-GitHub, create-from-scratch, and explain/config onboarding.
  empty: {
    placement: "workspace",
    hubs: [{ container: "notes", fixture: "fixtures/plain-notes" }],
  },
  // Single git-backed hub with a push origin — for sync.
  git: {
    placement: "registered",
    hubs: [{ container: "git-hub", fixture: "fixtures/git-hub", backend: "git-auto" }],
  },
  // Two registered hubs: a local folder + a git hub — for local-folder and multi-hub cases.
  "local-and-git": {
    placement: "registered",
    hubs: [
      { container: "kb-hub", fixture: "fixtures/kb-hub", backend: "local" },
      { container: "git-hub", fixture: "fixtures/git-hub", backend: "git-auto" },
    ],
  },
} satisfies Record<string, Environment>;
export type EnvName = keyof typeof environments;

export interface Provisioned {
  root: string; okhHome: string; copilotHome: string; workspace: string;
  containerPath: string;      // primary hub's local path ("" for a workspace-placed hub's dir)
  originPath?: string;        // primary hub's bare origin, if git-backed
}
export function provisionEnvironment(
  env: EnvName,
  opts: { repoRoot: string; label?: string; runner?: typeof run },
): Promise<Provisioned>;
```

`provisionEnvironment` builds the isolated `root` (okhHome / copilotHome / workspace),
then per hub: **workspace** placement copies the fixture to `workspace/<container>` (left
unregistered, registry empty); **registered** placement copies to
`okhHome/containers/<container>` and registers it, seeding a bare origin + clone when the
hub's `backend` is `git-auto`. Finally it writes `mcp-config.json`. `containerPath` /
`originPath` track `hubs[0]`.

### Scenario → environment mapping (16)

| env | scenarios |
|-----|-----------|
| `empty` (6) | onboard-add-existing-folder, onboard-add-github, onboard-create-local, onboard-explains, onboard-phrase, onboard-wake-phrase |
| `git` (1) | learn-integrates |
| `local-and-git` (9) | ask-grounded, ask-declines-when-absent, ask-multi-container, context-assembly, context-includes-skills-tools, learn-rejects-trivial, reflect-insights, remember-records, remember-no-conclusions |

`kb-hub` is the primary local hub in `local-and-git`; the 8 single-hub scenarios query it
by name and ignore the also-registered `git-hub`. `ask-multi-container` uses both.

## test.yaml shape (before → after)

```yaml
# before
- description: ask-grounded
  vars:
    prompt: file://scenarios/ask/grounded/prompt.md
    scenario: ask-grounded
    backend: local
    container: kb-hub
    fixture: fixtures/kb-hub
  assert: [ ... ]
# after
- description: ask-grounded
  vars:
    prompt: file://scenarios/ask/grounded/prompt.md
    env: local-and-git
  assert: [ ... ]
```

## Files to change

- **Create** `eval/environments.ts` — the env map + types (`EvalBackend`, `EnvHub`,
  `Environment`, `Provisioned`, `EnvName`) + `provisionEnvironment()` (absorbs all of
  `provision.ts`'s logic: build root, place/register hubs, seed git origins, write
  mcp-config).
- **Delete** `eval/provision.ts` (fully replaced by `environments.ts`).
- **Modify** all 16 `eval/scenarios/<verb>/<case>/test.yaml`: `vars` → `{ prompt, env }`;
  remove `scenario`/`backend`/`container`/`fixture`/`provision`/`container2`/`fixture2`.
- **Modify** `eval/provider/copilotProvider.ts`: import from `environments.ts`; read
  `vars.env`, call `provisionEnvironment(env, { repoRoot, label: description })`; drop the
  per-var provisioning plumbing.
- **Modify** `eval/okh-eval.ts`: `ScenarioTest.vars` → `{ prompt, env }`; `setupScenario`/
  `runChecks` call `provisionEnvironment` and resolve the primary container via
  `environments[env].hubs[0].container`; drop the `--backend` override (backend is per-hub
  in the env).
- **Rename/rewrite** `eval-test/provision.test.ts` → `eval-test/environments.test.ts`:
  cover `provisionEnvironment` for each env — `git` (registered git hub + origin),
  `local-and-git` (local kb-hub + git git-hub both registered), `empty` (empty registry +
  unregistered `notes` folder in workspace).
- **Modify** `eval-test/config.test.ts`: assert each test's `vars.env` ∈ `environments`
  (no legacy vars); keep the 16-id coverage + judge-criteria checks.
- **Modify** `eval-test/okh-eval.test.ts`: update to `env`-based vars.
- **Modify** `eval/MANUAL-TESTING.md`: reference `env` instead of the setup vars.

## Cleanup (comprehensive review)

- **Delete `eval/provision.ts`** and its three-mode abstraction — subsumed by
  `environments.ts`. The formerly-separate pure-`empty` mode is gone (no dead code).
- **Remove `scenario` var** from all 16 test.yaml (redundant with `description`).
- **Drop `mustNotContain: []`** from `ask-grounded` and `context-includes-skills-tools`
  transcript asserts (the field defaults to `[]`; the empty value is noise).
- **Drop `provision: registered`** from `ask-multi-container` (subsumed by the env).
- **No dead files:** `_compare.ts` and `checks.ts` are used internally; all 3 fixtures and
  all 10 test-referenced assertions are used. `eval/reports/*.json` is gitignored — n/a.

## Risks & validation

- **Reduced isolation is accepted, not minimized.** The 8 kb-hub scenarios run with
  `git-hub` also registered (prompts scope to "container kb-hub"); the onboarding
  create/explain scenarios run with a stray unregistered `notes` folder present. Prompts
  are explicit, so 16/16 is expected to hold. **The full live eval is the gate.** If a
  scenario regresses, fix the scenario/prompt or tweak the shared env — **do not** add a
  new environment (consolidation is the priority).
- **git provisioning** runs for the `git` and `local-and-git` envs (init/clone/push).
  Acceptable; covered by `environments.test.ts`.

## Verification

- `npm run eval:validate` (valid) · `npm run typecheck:eval` · `npm run test:eval`.
- Offline `echo` run over `scenarios/*/*/test.yaml`: 16 results, one dense prompt column.
- Larger change → full live `npm run eval` must stay **16/16**; then confirm the viewer
  results grid has no null cells and the Datasets tab lists 16 test cases.
