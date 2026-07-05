# OKH E2E Eval Harness (GitHub Copilot CLI)

End-to-end tests that exercise the **real** Open Knowledge Hub MCP server **inside
GitHub Copilot CLI** against real fixture containers. There is **no external grader
key** — both the agent and the judge run through Copilot CLI.

The same 16 scenarios run two ways:

- **Automated** — [promptfoo](https://promptfoo.dev) drives a custom Copilot-CLI
  provider, applies deterministic `javascript` assertions plus a Copilot-CLI **judge**,
  and produces a browsable report.
- **Manual & exploratory** — provision one scenario, run it by hand in an interactive
  Copilot session, and inspect the side-effects yourself.

Design notes: `docs/superpowers/specs/2026-07-02-okh-e2e-copilot-cli-design.md` and
`docs/superpowers/specs/2026-07-04-okh-eval-environments-design.md`.

---

## How it works

One eval run for a scenario is:

```
promptfoo (eval/scenarios/<verb>/<case>.yaml — one complete config per prompt)
  └─ shared provider (scenarios/shared/provider.ts → provider/copilotProvider.ts)
       ├─ provisionEnvironment(env)  ← environments.ts
       │    builds an isolated temp Root:
       │      okh-home/      (OKH_HOME: registry + copied fixture containers)
       │      copilot-home/  (COPILOT_HOME: mcp-config.json → node dist/index.js)
       │      workspace/     (the agent's cwd)
       │    launches:  copilot -p "<prompt>" --allow-all --model <model>
       └─ returns the transcript + metadata (containerPath, originPath, toolCalls, …)
  └─ assertions grade the transcript + on-disk side-effects:
       • deterministic javascript assertions (tools called, files changed, git commits…)
       • a Copilot-CLI judge (binary criteria, self-consistency, cross-checked)
```

Everything is isolated per run: each scenario gets its own `OKH_HOME`, `COPILOT_HOME`,
and working directory in a throwaway temp dir, so runs never touch your real hub or
each other.

Key files (`file://` paths in each config resolve relative to that config's own
folder, so scenarios use `../shared/…` and `../../assertions/…` to reach up to `eval/`):

| File | Role |
|------|------|
| `scenarios/shared/provider.ts` | the shared provider — the Copilot provider preconfigured with the default model/timeout; injected by every scenario config |
| `scenarios/<verb>/<case>.yaml` | one **complete** promptfoo config per prompt: injects the shared provider, an inline prompt, and a single env-bound test + asserts |
| `environments.ts` | defines the 3 environments **and** provisions them (`provisionEnvironment`) |
| `provider/copilotProvider.ts` | provisions the scenario's env, runs `copilot -p`, returns transcript + metadata |
| `copilot.ts` | spawns Copilot CLI; `extractToolCalls` parses MCP tool calls from the transcript |
| `assertions/*.ts` | deterministic checks + the judge |
| `okh-eval.ts` | the manual harness (`npm run eval:setup -- …`) |
| `fixtures/` | the seed containers (`kb-hub`, `git-hub`, `plain-notes`) |

---

## Prerequisites

- **`npm run build`** — the harness launches the **built** server (`dist/index.js`), so
  rebuild after any `src/` change.
- **`copilot` installed and authenticated.** Each run uses an isolated `COPILOT_HOME`, so
  auth must resolve independently of it:
  - **macOS & Windows — no token needed.** The CLI login lives in the OS credential store
    (Keychain / Windows Credential Manager), not in `COPILOT_HOME`, so a logged-in machine
    authenticates the spawned `copilot` automatically.
  - **Linux / CI — set a token.** On hosts that store the login *inside* `COPILOT_HOME`
    (which the harness wipes per run), export `COPILOT_GITHUB_TOKEN` or `GH_TOKEN`.
- **`promptfoo`** — installed as a devDependency (no global install needed).
- All commands below run from the repo root; examples are PowerShell (Windows).

---

## How test cases work

Each prompt is its **own complete promptfoo config file**, one per line in a per-verb
folder under `scenarios/`. There is no central `promptfooconfig.yaml` — every file
stands alone and can be run on its own with `promptfoo eval -c <file>`.

| folder | configs |
|--------|---------|
| `ask/` (3) | `answerable`, `missing-info`, `across-hubs` |
| `context/` (2) | `login-task`, `csv-debug` |
| `learn/` (2) | `useful-fact`, `trivial-fact` |
| `remember/` (2) | `incident`, `test-result` |
| `reflect/` (1) | `memory-module` |
| `onboard/` (6) | `explain`, `cold-start-phrase`, `custom-name`, `new-hub`, `existing-folder`, `github-repo` |

Each config looks like:

```yaml
# scenarios/ask/answerable.yaml — one complete config
description: Ask - answerable question - grounded answer, cites source
providers:
  - file://../shared/provider.ts   # inject the shared provider (model/timeout live there)
prompts:
  - label: ask-answerable          # globally-unique label, used to bind the test below
    raw: |                         # the exact prompt sent to the agent (inline, no var)
      Use the open-knowledge-hub MCP tools. In container "kb-hub", answer strictly
      from its knowledge module: How does auth work?
tests:
  - vars:
      env: local-and-git           # which environment to provision (see below)
    prompts: [ask-answerable]      # run only against this file's own prompt
    assert:
      - { type: javascript, value: file://../../assertions/tools-called.ts, config: { expect: [ask] } }
      - { type: javascript, value: file://../../assertions/transcript.ts, config: { mustContain: ["token"] } }
      - type: javascript
        value: file://../../assertions/judge.ts
        config:
          criteria:                # binary pass/fail statements (see Judge)
            - id: grounded-token-auth
              text: The answer reflects token-based auth from the Auth concept.
            - id: cites-auth
              text: The answer cites the Auth concept or its source path.
```

- **`description`** is a readable sentence — it names the test case (row) in the viewer.
- **`providers`** injects `scenarios/shared/provider.ts` — the one place the model and
  timeout are set, so all 16 configs share them (a `.ts` module because promptfoo inlines
  a `file://…ts` referenced from inside a provider *yaml*).
- **`prompts[0].raw`** is the prompt, inline (no `{{prompt}}` var); its **`label`** is unique.
- **`vars.env`** names the environment to provision — no per-test backend/container/fixture.
- **`tests[0].prompts: [label]`** binds the test to its own prompt. This matters for the
  full run: `npm run eval` combines every config via a glob, and the filter keeps each test
  on its own prompt (a diagonal grid) instead of the prompt×test cross-product.

### Environments

An environment defines the starting state and is provisioned by `provisionEnvironment`
(`environments.ts`). `hubs[0]` is the **primary** hub (it drives the metadata that
side-effect assertions read: `containerPath`, `fixtureDir`, `originPath`).

| env | placement | hubs | used for |
|-----|-----------|------|----------|
| `local-and-git` | registered | `kb-hub` (local) + `git-hub` (git) | the 8 `kb-hub` scenarios + `ask/across-hubs` |
| `git` | registered | `git-hub` (git-auto, with a seeded push origin) | `learn/useful-fact` (sync) |
| `empty` | workspace | `notes` (unregistered folder in the cwd) | the 6 `onboard/*` scenarios |

- **`registered`** copies each hub into `OKH_HOME/containers/<name>` and registers it;
  `git-auto` hubs also get a throwaway **bare origin** seeded and cloned so `sync` has
  somewhere to push.
- **`workspace`** copies the hub into the working directory as an **unregistered** folder
  (empty registry) — the starting point for "add my existing folder", "create a new hub",
  or "add from a URL".

To add or change an environment, edit `environments.ts`; scenarios only reference it by
name. Consolidation is intentional — scenarios are **not** minimally isolated (e.g. the
`ask` scenarios run with `git-hub` also present); their prompts are scoped to a named
container, and the full eval is the gate.

Fixtures (`fixtures/`):

- **`kb-hub`** — a rich container: `kb` knowledge (an Auth concept), a `debugging` skill,
  a `csv2json` tool, and a `mem` module with two dated entries about a recurring
  token-refresh / clock-skew issue.
- **`git-hub`** — a `kb` knowledge module (used as the git-backed hub).
- **`plain-notes`** — a minimal folder used as the unregistered `notes` hub.

### Assertions

Deterministic assertions (`assertions/*.ts`) inspect the transcript or the on-disk
side-effects — no model needed:

| assertion | checks |
|-----------|--------|
| `tools-called` | the expected OKH tools appear in the transcript (`config.expect`) |
| `transcript` | substrings that must / must not appear (`mustContain` / `mustNotContain`) |
| `okf-valid` | a module's OKF concepts are valid; optionally changed vs. the fixture |
| `memory-append` | a new dated entry was appended to a memory module (append-only) |
| `module-unchanged` | a module was **not** modified (guardrail / rejection cases) |
| `git-committed` | the git origin gained commits beyond the seed (i.e. `sync` pushed) |
| `container-registered` | a container is registered with the expected backend/module |
| `manifest-initialized` | an OKH manifest was created for a container |
| `wake-phrase-set` | the wake phrase preference was set |

### The judge

`assertions/judge.ts` grades each scenario against a list of **binary criteria** (not a
0–1 score), through Copilot CLI. For robustness it uses **self-consistency**: the agent
runs once, then the judge grades that transcript **`k` times** (default 3; override with
`config.k` per assertion or the `OKH_JUDGE_K` env var) and each criterion is decided by
**majority vote**. A criterion with fewer than `ceil(k/2)` valid votes, or a tie, is
`UNRELIABLE` and fails.

Any objectively checkable criterion carries a `check` (`tool`, `container`, `manifest`,
`wake-phrase`, `transcript-contains`, `transcript-absent`). The judge still grades it, but
its verdict is **cross-checked against deterministic ground truth**; a
judge/deterministic disagreement fails the scenario and is flagged in the reason. A green
result is therefore reproducible within majority tolerance and self-auditing.

---

## Running automatically

```powershell
npm run build            # rebuild dist/index.js first (the harness runs the built server)
$env:GH_TOKEN = "..."    # Linux/CI only; skip on a logged-in macOS/Windows machine
npm run eval:validate    # structural promptfoo validation (via node --import tsx)
npm run eval             # full live run (premium usage) — all 16 scenarios
npm run eval:view        # open the report + Prompts/Datasets/Results UI
# a single scenario: promptfoo eval -c eval/scenarios/ask/answerable.yaml
```

> **Validation:** `npm run eval:validate` launches promptfoo via `node --import tsx`,
> matching `npm run eval`, so the TypeScript provider can keep NodeNext `.js` import
> specifiers. Both combine every config via the glob
> `eval/scenarios/{ask,context,learn,remember,reflect,onboard}/*.yaml` (the `shared/`
> folder is excluded). Expect validation to end with `Configuration is valid.`

**Cost:** each scenario is **one agent call + `k` judge calls** (default `k=3`). Set
`OKH_JUDGE_K=1` for cheap local iteration. Response caching is disabled for the agent
(`--no-cache`).

**Model matrix:** change the default `model` in `scenarios/shared/provider.ts`, or add a
second provider entry (`{ id: file://../shared/provider.ts, config: { model: … } }`) to the
configs you want to compare; view them side-by-side in `npm run eval:view`. **Comparing
builds:** run the suite on two OKH git branches and compare in the viewer.

**Unit-testing the harness itself** (no premium usage, no Copilot CLI):

```powershell
npm run typecheck:eval   # type-check eval sources
npm run test:eval        # vitest unit tests for environments/provider/assertions/harness
```

---

## Running manually (with example prompts)

Manual mode is **environment-centric**: you provision one of the three environments, and
the harness prints every test prompt that uses it (with an expected-outcome checklist) for
you to run by hand and eyeball. Runs are **recorded**, so follow-up commands need no paths.

```powershell
npm run eval:setup -- list                 # list environments + how many prompts each has
npm run eval:setup -- setup local-and-git  # provision an environment; print its test prompts
npm run eval:setup -- enter                # interactive Copilot session in that environment
npm run eval:setup -- clean                # delete the temp run
```

- **`setup <env>`** (`empty` | `git` | `local-and-git`) builds the isolated temp Root and
  prints the Root/Workspace paths, the `enter`/`clean` commands, and — for every test that
  uses this environment — its description, prompt, and expected-outcome checklist. Nothing
  is spawned yet; no premium usage.
- **`enter [env]`** opens an interactive session (most-recent run, or the named env); `/mcp`
  confirms **open-knowledge-hub** is loaded. Paste one of the printed prompts, watch it
  work, and verify against that prompt's checklist and by inspecting the workspace.
  `--model <M>` overrides the model.
- **`clean [env]`** removes the run (or pass an explicit path).

There is no automated `check` in manual mode — verification is by eye (the printed
checklist says what to look for); the deterministic assertions run in `npm run eval`.

### Example prompts (one per flow)

`setup <env>` prints all of an environment's prompts; a few highlights:

- **ask** (env `local-and-git`):
  > Use the open-knowledge-hub MCP tools. In container "kb-hub", answer strictly from its
  > knowledge module: How does auth work?

  Expect: calls `ask`, mentions session tokens, cites the Auth concept, invents nothing.
  The sibling "decline" test asks for a vacation policy and should **decline** rather than
  fabricate.

- **context** (env `local-and-git`):
  > …assemble a working set for this task in container "kb-hub": debug a failing test that
  > parses a CSV file. Include every module type that helps and cite each by path.

  Expect: selects the `debugging` skill and the `csv2json` tool, not just knowledge.

- **learn** (env `git`):
  > Learn the following into container "git-hub" and persist it: "Session tokens are signed
  > with RS256 and the public keys are rotated weekly." Then sync.

  Expect: writes a valid OKF concept and `sync` commits **and pushes** to the bare origin
  (`git-committed` verifies it). The sibling "reject" test ("the sky is blue") should be
  **rejected** by the okf-learn gate (`module-unchanged` verifies nothing changed).

- **remember** (env `local-and-git`):
  > Remember this observation in container "kb-hub": "The login endpoint returned 500s for
  > ~3 minutes at 14:05 UTC during deploy."

  Expect: a new timestamped `mem/` entry (append-only), raw fact only, no conclusions.

- **reflect** (env `local-and-git`):
  > Reflect on the memory module of container "kb-hub" and produce lessons and proposed
  > updates.

  Expect: identifies the recurring token-refresh / clock-skew pattern across both memory
  entries and proposes a concrete update.

- **onboard** (env `empty`):
  > hub, create a new knowledge hub in a folder called "my-notes" and add a knowledge
  > module named "kb". Show me the plan and wait for my confirmation; assume I say yes.

  Expect: previews a plan, then `add` creates & registers `my-notes` with a `kb` module.
  The `empty` environment also covers explaining OKH, the cold-start phrase ("Use the Open
  Knowledge Hub MCP and run onboard to set me up."), setting a wake phrase, adding an
  existing folder, and cloning a hub from GitHub.

### Exploratory (free-form) testing

**Poke at a seeded fixture.** `setup local-and-git` (the rich `kb-hub`), `enter`, and throw
your own prompts at it — adversarial ones too (prompt-injection in a question, ambiguous
container/module, "rewrite an existing memory entry" which should stay append-only). After
each, inspect `<Root>\okh-home\containers\kb-hub` (files + `git`) to see exactly what
happened, then `clean`.

**Dogfood against a real hub.** Wire OKH into your normal Copilot CLI by adding to
`~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "open-knowledge-hub": {
      "command": "node",
      "args": ["D:\\work\\open-knowledge-hub\\dist\\index.js"],
      "env": { "OKH_HOME": "C:\\Users\\<you>\\.open-knowledge-hub" }
    }
  }
}
```

Then run `copilot` anywhere and use `ask` / `context` / `learn` / `remember` / `reflect`
plus `inspect` / `add` / `sync` against your own containers (`/mcp` confirms it loaded).

### PR-mode `sync` (manual only)

Automated e2e can't open real pull requests. To test `pr`-mode by hand:

1. Create/register a `pr`-mode git container against a repo you can push to.
2. `hub, learn this: <fact>` then confirm; `hub, open a PR with my changes.`
3. Verify `sync` created a branch `okh/<name>/sync-*`, pushed it, opened a PR via `gh`, and
   returned you to the base branch.

---

## Caveats & notes

- **Don't gate required CI on this suite.** Copilot CLI temperature isn't directly
  controllable; rely on self-consistent judging (and promptfoo `repeat`).
- `onboard/github-repo` clones the private repo `dryotta/okh-eval-hub`, which relies on the
  machine's `gh` credential helper (macOS/Windows) or a token with `repo` read (Linux/CI).
  No push/sync is exercised.
- Fixture workspaces are disposable temp dirs — mutate them freely, then `clean`. Each
  interactive turn consumes premium requests.
- On Windows, promptfoo may print a libuv assertion on process exit **after** a successful
  run — cosmetic.
- If a future Copilot CLI version renders MCP tool calls differently (currently
  `● <Title> (MCP: open-knowledge-hub) · args`), adjust `extractToolCalls` in `copilot.ts`.
