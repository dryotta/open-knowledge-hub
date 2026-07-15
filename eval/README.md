# OKH E2E Eval Harness (GitHub Copilot CLI)

End-to-end tests that exercise the **real** Open Knowledge Hub MCP server **inside
GitHub Copilot CLI** against real fixture containers. There is **no external grader
key** — both the agent and the judge run through Copilot CLI.

The same 28 scenarios run two ways:

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
promptfoo (eval/promptfooconfig.yaml — one {{prompt}} pass-through + scenarios: [file://scenarios/**/*.yaml])
  └─ shared provider (scenarios/shared/provider.ts → provider/copilotProvider.ts)
       ├─ provisionEnvironment(env)  ← environments.ts
       │    builds an isolated temp Root:
       │      okh-home/      (OKH_HOME: registry + copied fixture containers)
       │      copilot-home/  (COPILOT_HOME: mcp-config.json → node dist/index.js)
       │      workspace/     (the agent's cwd)
       ├─ runConversation(...)  ← copilot.ts
       │    turn 1:  copilot -p "<prompt>" --session-id <uuid> --allow-all --output-format json --model <model>
       │    then per scripted reply:  copilot -p "<reply>" --resume=<uuid> ...   (single-turn = just turn 1)
       └─ returns the aggregated transcript + metadata (containerPath, originPath, toolCalls, toolEvents, cost, …)
  └─ assertions grade the transcript + on-disk side-effects:
       • deterministic javascript assertions (tools called, files changed, git commits…)
       • a Copilot-CLI judge (binary criteria, self-consistency)
```

Everything is isolated per run: each scenario gets its own `OKH_HOME`, `COPILOT_HOME`,
and working directory in a throwaway temp dir, so runs never touch your real hub or
each other.

Key files:

| File | Role |
|------|------|
| `promptfooconfig.yaml` | the single default config: `{{prompt}}` pass-through + shared provider + `scenarios:` glob |
| `scenarios/shared/provider.ts` | the shared provider — the Copilot provider preconfigured with the default model/timeout |
| `scenarios/<verb>/<case>.yaml` | one scenario (a one-element list): `config.vars` (prompt+env) + `tests[0].assert` |
| `environments.ts` | defines the 6 environments **and** provisions them (`provisionEnvironment`) |
| `provider/copilotProvider.ts` | provisions the scenario's env, drives the (multi-turn) conversation, returns transcript + metadata |
| `copilot.ts` | spawns Copilot CLI turns; `runConversation` drives multi-turn (session resume, JSON output); `parseCopilotEvents` extracts messages/tools/cost |
| `assertions/*.ts` | deterministic checks + the judge |
| `run-scenarios.ts` | runs `promptfoo eval`/`validate` once on `promptfooconfig.yaml` (single process, concurrent scenarios) |
| `manual.ts` | one-shot manual harness (`npm run manual`) with isolated homes and automatic cleanup |
| `fixtures/` | the seed containers (`kb-hub`, `git-hub`, `plain-notes`, `custom-hub`, `health-hub`, `wiki-hub`) |

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

`eval/promptfooconfig.yaml` is the single default config. It declares one pass-through
prompt, the shared provider once, and a glob of every scenario file:

```yaml
prompts:
  - "{{prompt}}"
providers:
  - file://scenarios/shared/provider.ts
scenarios:
  - file://scenarios/**/*.yaml
```

Each `scenarios/<verb>/<case>.yaml` is a **one-element scenario list**: its `config[0].vars`
supplies the case's `prompt` (rendered into `{{prompt}}`) and `env`, and its `tests[0].assert`
holds the case's assertions. One prompt template × N scenarios means no prompt×test
cross-product — promptfoo runs the scenarios concurrently (default 4 workers) in a single run,
so all cases land in **one** eval record you can browse in `npm run eval:view`.

```yaml
# scenarios/ask/answerable.yaml — one scenario
- config:
    - vars:
        env: local-and-git
        prompt: |
          Use the open-knowledge-hub MCP tools. In container "kb-hub", answer strictly
          from its knowledge module: How does auth work?
  tests:
    - description: Ask - answerable question - grounded answer, cites source
      assert:
        - { type: javascript, value: file://assertions/tools-called.ts, config: { expect: [ask] } }
        - { type: javascript, value: file://assertions/transcript.ts, config: { mustContain: ["token"] } }
        - type: javascript
          value: file://assertions/judge.ts
          config:
            criteria:
              - id: grounded-token-auth
                text: The answer reflects token-based auth from the Auth concept.
```

- **Assertion `file://` paths are relative to `eval/`** (the config dir) — `file://assertions/…`,
  not `../../assertions/…`. promptfoo resolves nested `file://` refs against the base config.
- **`tests[0].description`** names the case — it labels the row in `npm run eval:view` and is selectable via `--filter-pattern "<description>"`.
- **`config[0].vars.env`** names the environment to provision (see below).

### Environments

An environment defines the starting state and is provisioned by `provisionEnvironment`
(`environments.ts`). `hubs[0]` is the **primary** hub (it drives the metadata that
side-effect assertions read: `containerPath`, `fixtureDir`, `originPath`).

| env | placement | hubs | used for |
|-----|-----------|------|----------|
| `local-and-git` | registered | `kb-hub` (local) + `git-hub` (git-auto) | `ask/*`, `context/*`, `remember/*`, `reflect/*`, `learn/trivial-fact` |
| `empty` | workspace | `notes` (unregistered folder in the cwd) | `onboard/*`, `run/shared-grilling` |
| `wiki` | registered | `wiki-hub` (local) | `initialize/llmwiki`, `ask/llmwiki-compounding`, `write/*` |
| `custom` | registered | `custom-hub` (local) | `inspect/custom-module`, `run/custom-skill` |
| `health` | registered | `health-hub` (local); `workspaceDir` = `fixtures/health-source` | `ingest/into-existing-module`, `lint/*` |
| `git` | registered | `git-hub` (git-auto, with a seeded bare origin) | `learn/useful-fact` (sync) |

- **`registered`** copies each hub into `OKH_HOME/containers/<name>` and registers it;
  `git-auto` hubs also get a throwaway **bare origin** seeded and cloned so `sync` has
  somewhere to push.
- **`workspace`** copies the hub into the working directory as an **unregistered** folder
  (empty registry) — the starting point for "add my existing folder", "create a new hub",
  or "add from a URL".

To add or change an environment, edit `environments.ts`; scenarios only reference it by
name.

Fixtures (`fixtures/`):

- **`kb-hub`** — a rich container: `kb` knowledge (an Auth concept), a nested
  `engineering/testing/debugging` skill, a `csv2json` tool, and a `mem` module with
  two dated entries about a recurring token-refresh / clock-skew issue.
- **`git-hub`** — a `kb` knowledge module (used as the git-backed hub; appears alone or alongside `kb-hub`).
- **`plain-notes`** — a minimal folder used as the unregistered `notes` hub.
- **`custom-hub`** — a container with a `recipes` custom module including a `cook` skill.
- **`health-hub`** — a container with a `health` knowledge module (retains source copies) and a `wiki` llmwiki module seeded with unhealthy state (orphan page, dangling link) for lint scenarios.
- **`wiki-hub`** — a container with a `new-wiki` llmwiki module (pre-initialized scope contract) and a `wiki` llmwiki module with clean health baseline for initialize/ask/write scenarios.

### Multi-turn scenarios

Most scenarios are single-turn: one prompt, one agent reply (`vars.turns` omitted or
empty). Conversational flows declare `vars.turns` — scripted user replies driven by a
**state machine**. The harness sends each turn via a resumed session (`--session-id` on
turn 1, then `--resume=<id>`), one `copilot -p` invocation per turn.

Each `turns` entry is `{ id, after, when?, send }`:

- **`id`** — the state this turn transitions to when selected.
- **`after`** — the state (string or list) from which this turn is eligible; initial state is `"start"`.
- **`when`** — optional case-insensitive regex matched against the agent's last message. **Use `when` only for true sibling-branch discrimination** (e.g. the agent may ask about purpose *or* goals first and you need different replies). For linear sequencing, omit `when` — the `after` chain alone drives turn order.
- **`send`** — the user message to send.

A `terminal: { after, requiredTools? }` block marks the finishing state. The conversation
stops when that state is reached and all `requiredTools` have been successfully called.

Unmatched state (no eligible turn matches the current state), hitting `maxTurns` (default
`responses.length + 2`), or a non-zero process exit are all **explicit failures** and
surface as `metadata.failure`.

```yaml
# scenarios/onboard/cold-start-conversation.yaml (excerpt)
# All turns are unguarded — `after` state drives the linear conversation.
vars:
  env: empty
  prompt: "Use the Open Knowledge Hub MCP and run onboard to set me up."
  turns:
    - id: wake-phrase
      after: start
      send: "Let's call it 'brain'."
    - id: container-choice
      after: wake-phrase
      send: "Create a brand-new folder called \"my-notes\" with a knowledge module named \"kb\"."
    - id: create-confirmed
      after: container-choice
      send: "Yes, go ahead and create it."
    - id: wrap-up
      after: create-confirmed
      send: "Thanks — how would I use it day to day?"
  terminal:
    after: wrap-up
    requiredTools: [onboard, config, add_container]
```

The provider reads each turn via `--output-format json`, extracting the agent's message,
OKH tool calls, and the run's cumulative cost. `metadata.toolEvents` is the full ordered
list of **completed + successful** OKH tool executions across all turns, each retaining
`server`, `tool`, `arguments`, and `turn` index. `metadata.toolCalls` is the deduped
sorted name list derived from the same events. The aggregated transcript (labelled
`USER`/`AGENT` blocks per turn) is what the judge and `transcript` assertions grade.

### Assertions

Deterministic assertions (`assertions/*.ts`) inspect the transcript or the on-disk
side-effects — no model needed:

| assertion | checks |
|-----------|--------|
| `tools-called` | every expected OKH tool was completed successfully; `expect` items are tool-name strings or `{ name, arguments?, server?, turn? }` tuples; `ordered: true` requires event-order match |
| `transcript` | substrings that must / must not appear (`mustContain` / `mustNotContain`) |
| `okf-valid` | a module's OKF concepts are valid; optionally changed vs. the fixture |
| `memory-append` | exactly one new Markdown entry was appended (no prior content rewritten); entry contains exactly one ISO timestamp heading and the configured `observation` preserved verbatim |
| `module-unchanged` | a module was **not** modified (guardrail / rejection cases) |
| `git-committed` | the git origin gained commits beyond the seed (i.e. `sync` pushed) |
| `container-registered` | a container is registered with the expected backend/module |
| `manifest-initialized` | an OKH manifest was created for a container |
| `wake-phrase-set` | the wake phrase preference was set |
| `source-retained` | a source file was copied into the module's `sources/` folder |
| `llmwiki-state` | llmwiki module artifacts: index text, group index files, no content pages, expected new page type/terms, index+log changed, clean health |

`tools-called` example with structured tuples and `ordered: true`:

```yaml
- type: javascript
  value: file://assertions/tools-called.ts
  config:
    ordered: true
    expect:
      - name: run
        arguments: { container: wiki-hub, module: new-wiki, skill: initialize }
      - name: run
        arguments: { skill: grilling }
      - name: sync
```

### The judge

`assertions/judge.ts` grades each scenario against a list of **binary criteria** (not a
0–1 score), through Copilot CLI. For robustness it uses **self-consistency**: the agent
runs once, then the judge grades that transcript **`k` times** (default 3; override with
`config.k` per assertion or the `OKH_JUDGE_K` env var) and each criterion is decided by
**majority vote**. A criterion with fewer than `ceil(k/2)` valid votes, or a tie, is
`UNRELIABLE` and fails.

Judge votes run concurrently by default. `OKH_JUDGE_CONCURRENCY` caps parallel votes per
scenario (maximum `k`); set it to `1` to restore sequential judging. Invalid values fall
back to `k`. The tested agent is pinned to `claude-sonnet-4.5`, while the judge defaults
to the faster `gpt-5.6-luna`. Override the judge globally with `OKH_JUDGE_MODEL`, or per
assertion with `graderModel`.

A criterion carrying a `check` (`tool`, `container`, `manifest`, `wake-phrase`,
`transcript-contains`, `transcript-absent`) is evaluated **deterministically** — the
check result is authoritative and gates pass/fail regardless of the judge. The judge's
concurrent majority-vote verdict is logged for diagnostics only. Criteria without a
`check` use pure judge behaviour: majority vote decides, and `UNRELIABLE` (tie or
insufficient votes) fails.

---

## Running automatically

```powershell
npm run build            # rebuild dist/index.js first (the harness runs the built server)
$env:GH_TOKEN = "..."    # Linux/CI only; skip on a logged-in macOS/Windows machine
npm run eval:validate    # structural promptfoo validation
npm run eval             # full live run (premium usage) — all scenarios, concurrently
npm run eval:view        # open the report + Prompts/Datasets/Results UI
# a single scenario: filter by description, e.g. promptfoo eval -c eval/promptfooconfig.yaml --filter-pattern "Ask - answerable"
```

> **One config, concurrent scenarios.** `npm run eval` / `eval:validate` run a **single**
> `promptfoo` process on `eval/promptfooconfig.yaml` (via `run-scenarios.ts`), which globs
> every `scenarios/**/*.yaml` scenario and runs them with promptfoo's default concurrency.
> All cases share one eval record — pick a row in `npm run eval:view`. Both invoke promptfoo
> through `node --import tsx` so the TypeScript provider keeps NodeNext `.js` import specifiers;
> validation prints `Configuration is valid.`

**Cost:** each scenario is **N agent turns + `k` judge calls** (single-turn scenarios have
`N=1`; multi-turn scenarios run one agent turn per scripted reply; `k` defaults to 3). Set
`OKH_JUDGE_K=1` for cheap local iteration. Parallel voting reduces wall time, not premium
usage. Response caching is disabled for the agent (`--no-cache`).

**Model matrix:** change the default `model` in `scenarios/shared/provider.ts` (one place),
then compare runs in `npm run eval:view`. **Comparing builds:** run the suite on two OKH
git branches and compare in the viewer.

**Unit-testing the harness itself** (no premium usage, no Copilot CLI):

```powershell
npm run typecheck:eval   # type-check eval sources
npm run test:eval        # vitest unit tests for environments/provider/assertions/harness
```

---

## Running manually (with example prompts)

Manual mode is a **one-shot** harness: it provisions one isolated environment, prints every
matching prompt with an expected-outcome checklist, launches Copilot CLI in that workspace,
then removes the **entire temp Root** when the session exits — normal, failed, or
interrupted. There are no separate setup / enter / cleanup commands.

```powershell
npm run build
npm run manual                             # default env: local-and-git
npm run manual -- git                      # choose an environment
npm run manual -- wiki --model gpt-5.6-luna # optional model override
$env:GH_TOKEN = "..."                      # Linux/CI only, if needed for auth
```

- Valid environments: `empty`, `git`, `local-and-git`, `custom`, `health`, `wiki`. Omitting
  the env uses `local-and-git`.
- The harness prints `OKH_HOME`, `COPILOT_HOME`, `Workspace`, and — for every scenario that
  uses the chosen environment — its description, prompt, and checklist.
- Run `/mcp` to confirm **open-knowledge-hub** is loaded, then paste one of the printed
  prompts and inspect the workspace / git side-effects yourself.
- There is no automated `check` in manual mode; the deterministic assertions still live in
  `npm run eval`.

### Example prompts (one per flow)

`npm run manual -- [env]` prints all of an environment's prompts; a few highlights:

- **ask** (env `local-and-git`):
  > Use the open-knowledge-hub MCP tools. In container "kb-hub", answer strictly from its
  > knowledge module: How does auth work?

  Expect: calls `ask`, mentions session tokens, cites the Auth concept, invents nothing.
  The sibling "decline" test asks for a vacation policy and should **decline** rather than
  fabricate.

- **context** (env `local-and-git`):
  > …assemble a working set for this task in container "kb-hub": debug a failing test that
  > parses a CSV file. Include every module type that helps and cite each by path.

  Expect: selects the nested `debugging` skill and the `csv2json` tool, not just knowledge.

- **learn** (env `git`):
  > Learn the following into container "git-hub" and persist it: "Session tokens are signed
  > with RS256 and the public keys are rotated weekly." Then sync.

  Expect: writes a valid OKF concept and `sync` commits **and pushes** to the bare origin
  (`git-committed` verifies it). The sibling "reject" test ("the sky is blue") should be
  **rejected** by the learn gate (`module-unchanged` verifies nothing changed).

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

**Poke at a seeded fixture.** Run `npm run manual -- local-and-git` (the rich `kb-hub`) and throw
your own prompts at it — adversarial ones too (prompt-injection in a question, ambiguous
container/module, "rewrite an existing memory entry" which should stay append-only). After
each, inspect `<Root>\okh-home\containers\kb-hub` (files + `git`) to see exactly what
happened before you exit; the harness cleans the temp Root automatically.

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

### Shared-mode `sync` and `publish-pr` (manual only)

Automated e2e can't open real pull requests. To test `shared`-mode by hand:

1. Create/register a `shared`-mode git container against a repo you can push to.
2. `hub, learn this: <fact>` — the agent edits files and calls `sync`, committing and pushing to the shared branch (e.g. `user/<login>/hub`).
3. `hub, publish my changes as a PR.` → `sync { action: "publish-pr" }` opens or returns the existing PR from the shared branch to main via `gh`.

---

## Caveats & notes

- **Don't gate required CI on this suite.** Copilot CLI temperature isn't directly
  controllable; rely on self-consistent judging (and promptfoo `repeat`).
- `onboard/github-repo` clones the private repo `dryotta/okh-eval-hub`, which relies on the
  machine's `gh` credential helper (macOS/Windows) or a token with `repo` read (Linux/CI).
  No push/sync is exercised.
- Fixture workspaces are disposable temp dirs — inspect and mutate them freely during the
  session; the harness removes the full temp Root on exit. Each interactive turn consumes
  premium requests.
- On Windows, promptfoo may print a libuv assertion on process exit **after** a successful
  run — cosmetic.
- If a future Copilot CLI version changes its `--output-format json` event shape (currently
  `assistant.message.toolRequests[]` / `tool.execution_start` carry `mcpServerName` +
  `mcpToolName`, and `result` carries `sessionId` + `usage.premiumRequests`), adjust
  `parseCopilotEvents` in `copilot.ts`.
