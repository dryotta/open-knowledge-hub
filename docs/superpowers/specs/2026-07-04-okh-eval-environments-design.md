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

- **Environments live in a TypeScript module** `eval/environments.ts` (typed map, imported
  by both the provider and the manual harness — DRY, compile-checked, no YAML parsing).
- **`scenario` var removed.** It only prefixed the temp dir. promptfoo passes
  `context.test.description` (= the scenario id) to the provider, and the manual harness
  already derives the id from the folder path. The temp-dir label comes from `description`.
- **A capability-based 3-environment model** (chosen over a 5-env behavior-preserving set),
  accepting reduced per-scenario isolation, validated by the full live eval.
- **`provision.ts` gains git-backed additional containers** so one env can hold a local
  hub + a git hub together.

## Environments (`eval/environments.ts`)

```ts
export type EvalBackend = "local" | "git-auto";
export interface EnvHub { container: string; fixture: string; backend?: EvalBackend; }
export interface Environment {
  provision: "registered" | "unregistered-local";
  hubs: EnvHub[]; // first = primary; rest = additional
}
export const environments = {
  // Empty registry with one UNREGISTERED folder sitting in the workspace. Serves
  // add-existing-folder, add-from-GitHub, create-from-scratch, and explain/config.
  empty: {
    provision: "unregistered-local",
    hubs: [{ container: "notes", fixture: "fixtures/plain-notes" }],
  },
  // Single git-backed hub with a push origin — for sync.
  git: {
    provision: "registered",
    hubs: [{ container: "git-hub", fixture: "fixtures/git-hub", backend: "git-auto" }],
  },
  // Two registered hubs: a local folder + a git hub — for local-folder and multi-hub cases.
  "local-and-git": {
    provision: "registered",
    hubs: [
      { container: "kb-hub", fixture: "fixtures/kb-hub", backend: "local" },
      { container: "git-hub", fixture: "fixtures/git-hub", backend: "git-auto" },
    ],
  },
} satisfies Record<string, Environment>;
export type EnvName = keyof typeof environments;
```

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

- **Create** `eval/environments.ts` (typed map above + a resolver helper).
- **Modify** all 16 `eval/scenarios/<verb>/<case>/test.yaml`: `vars` → `{ prompt, env }`;
  remove `scenario`/`backend`/`container`/`fixture`/`provision`/`container2`/`fixture2`.
- **Modify** `eval/provider/copilotProvider.ts`: read `vars.env`, resolve via
  `environments`, map to `provision()` args; temp-dir label from `context.test.description`.
- **Modify** `eval/provision.ts`: `additional` accepts an optional `backend: "git-auto"`;
  git additional seeds its own bare origin + clone (same as the primary git path).
  `ProvisionInput.scenario` becomes `label` (temp-dir prefix), defaulted.
- **Modify** `eval/okh-eval.ts`: `ScenarioTest.vars` → `{ prompt, env }`; `setupScenario`/
  `runChecks` resolve the env to provision args + the primary container name; drop
  `--backend` override (backend now comes from the env).
- **Modify** `eval-test/config.test.ts`: assert each test has `vars.env` ∈ `environments`
  (no legacy vars); keep the 16-id coverage + judge-criteria checks.
- **Modify** `eval-test/okh-eval.test.ts` and `eval-test/provider.test.ts`: update to the
  `env`-based vars; multi-container test asserts kb-hub + git-hub registered.
- **Modify** `eval/MANUAL-TESTING.md`: mention `env` instead of the setup vars.

## Cleanup (comprehensive review)

- **Remove `scenario` var** from all 16 test.yaml (redundant with `description`).
- **Drop `mustNotContain: []`** from `ask-grounded` and `context-includes-skills-tools`
  transcript asserts (the field defaults to `[]`; the empty value is noise).
- **Drop `provision: registered`** from `ask-multi-container` (default; subsumed by env).
- **No dead files:** `_compare.ts` and `checks.ts` are used internally; all 3 fixtures and
  all 10 test-referenced assertions are used. `eval/reports/*.json` is gitignored — n/a.
- **`empty` provision mode becomes unreferenced** once onboarding uses
  `unregistered-local`. Default: **keep it** as a small tested provision primitive (its
  provider test stays valid); note it as unused. Remove only if the reviewer prefers.

## Risks & validation

- **Reduced isolation.** The 8 kb-hub scenarios now run with `git-hub` also registered
  (prompts are scoped "in container kb-hub"); the onboarding create/explain scenarios now
  have a stray unregistered `notes` folder present. Prompts are explicit, so 16/16 is
  expected to hold. **The full live eval is the gate.** If a scenario regresses, give it a
  dedicated env (accepting >3 envs for that case) rather than weakening the assertion.
- **git-additional provisioning** adds git init/clone/push to the 9 `local-and-git`
  scenarios. Acceptable; covered by `provision.test.ts`.

## Verification

- `npm run eval:validate` (valid) · `npm run typecheck:eval` · `npm run test:eval`.
- Offline `echo` run over `scenarios/*/*/test.yaml`: 16 results, one dense prompt column.
- Larger change → full live `npm run eval` must stay **16/16**; then confirm the viewer
  results grid has no null cells and the Datasets tab lists 16 test cases.
