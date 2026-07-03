# OKH E2E Testing in GitHub Copilot CLI — Design Spec

**Status:** Approved design (pre-implementation)
**Date:** 2026-07-02
**Depends on:** OKH v2 (`docs/superpowers/specs/2026-07-02-okh-v2-design.md`), merged to `main`.

---

## 1. Summary

An end-to-end test harness that exercises the **real OKH MCP server** inside
**GitHub Copilot CLI** against **real fixture containers**. It serves two goals:

1. **Regression** — catch quality drops when the OKH prompts/discipline change, or
   when different models are used.
2. **Optimization** — compare prompt/discipline variants to improve how well they
   deliver each prompt's goal.

The harness runs in two modes from **one set of scenario definitions**:

- **Automated eval** — [promptfoo](https://promptfoo.dev) is the outer shell; a
  custom promptfoo provider provisions an isolated workspace, runs `copilot -p`
  headless, and returns the transcript. promptfoo applies deterministic
  `javascript` assertions (hard gate) plus an `llm-rubric` judge (quality), and
  produces the report + `promptfoo view` comparison UI.
- **Manual** — the same provisioning, without the auto-run: it materializes a
  ready workspace and prints the launch command, prompt, and an expected-outcome
  checklist for interactive runs in Copilot CLI.

The agent under test is **Copilot CLI itself** (its harness, tool-permission
model, subagents, model routing) — not a raw provider model. That is why the
harness wraps `copilot -p` in a custom provider rather than using promptfoo's
built-in MCP integration (which drives raw provider models).

## 2. Why promptfoo as the outer shell

promptfoo cannot drive Copilot CLI as an agent directly, but its **custom
provider** API (`file://provider.ts`, a class with `id()` + `async callApi`) can
run any command. Wrapping `copilot -p` in a custom provider lets promptfoo own the
parts we would otherwise hand-build:

- test **matrix** across models,
- the **`llm-rubric`/`g-eval` judge** with an overridable grader provider,
- the **report** and the **`promptfoo view`** side-by-side comparison (key for the
  optimization goal),
- assertion taxonomy (`javascript` + model-graded).

We still own the OKH-specific parts: **provisioning/isolation**, **fixtures**,
**deterministic checkers** (reusing OKH's own parsers), and **rubrics**.

> **Caching note:** the agent provider is non-deterministic and has side effects,
> so promptfoo response caching is **disabled for it** (`--no-cache` or provider
> opt-out). promptfoo's value here is the matrix, judge, report, and compare-UI —
> not caching.

## 3. Architecture

```
promptfoo eval  (matrix • llm-rubric judge • report • `promptfoo view` compare)
  providers:  eval/provider/copilotProvider.ts  × [model list]   (each model = one provider entry)
  tests:      eval/scenarios/*/test.yaml          (one scenario = one promptfoo test)
  grader:     defaultTest.options.provider         (independent model by default; may be the copilot provider)

  copilotProvider.callApi(prompt, { vars }):
     1. provision(vars) → temp COPILOT_HOME + OKH_HOME + fixture copy (+ bare origin for git-auto) + mcp-config.json
     2. spawn `copilot -p "<prompt>" --allow-all --model <config.model>`   (env: COPILOT_HOME, GH_TOKEN; cwd: temp workspace)
     3. return { output: transcript, metadata: { workspace, okhHome, containerPath, originPath, toolCalls } }

  assert (per scenario):
     - javascript file://eval/assertions/*.ts  → read providerResponse.metadata.workspace; run file/git/tool checks   [HARD GATE]
     - llm-rubric  → grade transcript vs the scenario rubric ≥ threshold                                              [QUALITY]

  overall pass = (all deterministic checks pass) AND (rubric score ≥ threshold)
```

`provision()` is a **shared module** imported by both the provider (automated) and
the manual `setup` CLI, so both modes build identical workspaces.

## 4. Directory Layout

```
eval/
  README.md                     # runbook (manual + automated) + prereqs (GH_TOKEN, npm run build)
  promptfooconfig.yaml          # providers (copilot × models), defaultTest (grader + shared asserts),
                                #   tests: file://scenarios/*/test.yaml
  tsconfig.eval.json            # rootDir eval; run via tsx; excluded from dist/ and the npm package
  provision.ts                  # shared: isolated COPILOT_HOME + OKH_HOME, fixture copy, bare origin, mcp-config.json
  provider/copilotProvider.ts   # promptfoo custom provider: provision → copilot -p → transcript + metadata
  assertions/                   # reusable deterministic checkers (parametrized via assertion `config`)
    tools-called.ts
    transcript.ts
    okf-valid.ts
    memory-append.ts
    git-committed.ts
  okh-eval.ts                   # manual CLI: setup <scenario> | check <workspace> | list | clean
  scenarios/
    ask-grounded/{test.yaml, fixture/}
    ask-declines-when-absent/{test.yaml, fixtureRef}
    context-assembly/{test.yaml, fixtureRef}
    learn-integrates/{test.yaml, fixture/}          # git-auto
    learn-rejects-trivial/{test.yaml, fixtureRef}
    remember-records/{test.yaml, fixtureRef}
    remember-no-conclusions/{test.yaml, fixtureRef}
    reflect-insights/{test.yaml, fixture/}
  reports/                      # gitignored run reports
```

The runner runs via `tsx` (no build step for `eval/`), and **imports the
project's own parsers** (`src/util/frontmatter`, `src/container/manifest`, module
loaders) so deterministic checks use the exact OKF/manifest logic the server uses.
`eval/` is excluded from the published package (package `files` already lists only
`dist` + `resources`).

## 5. Scenario definition (`eval/scenarios/<name>/test.yaml`)

A scenario is a promptfoo **test**:

```yaml
vars:
  scenario: ask-grounded
  backend: local              # local | git-auto
  container: kb-hub
  fixture: ./fixture          # or `fixtureRef: ../ask-grounded/fixture`
  prompt: |
    Use the open-knowledge-hub tools. In container "kb-hub",
    answer: How does auth work?
assert:
  - type: javascript
    value: file://eval/assertions/tools-called.ts
    config: { expect: [ask] }
  - type: javascript
    value: file://eval/assertions/transcript.ts
    config: { mustContain: ["kb/auth.md"], mustNotContain: [] }
  - type: llm-rubric
    value: |
      PASS iff the answer is grounded ONLY in the container's knowledge module,
      cites the source path(s), and invents nothing.
    threshold: 0.8
```

`promptfooconfig.yaml` sends `{{prompt}}` (from `vars`) to the provider; the
provider reads the rest of `vars` to provision the correct fixture/backend.

## 6. Provisioning & Isolation (`provision.ts`)

Per test (or manual setup), build a temp root `T`:

1. **`OKH_HOME = T/okh-home`.** Copy the scenario's `fixture/` to the container
   location and write `T/okh-home/registry.json` registering it:
   - `local` → registered in place (container dir under `T`);
   - `git-auto` → `git init --bare T/origin.git`, seed it from the fixture, clone
     into `T/okh-home/containers/<name>`, manifest `sync: auto`.
2. **`COPILOT_HOME = T/copilot-home`** with `mcp-config.json`:
   ```json
   {
     "mcpServers": {
       "open-knowledge-hub": {
         "command": "node",
         "args": ["<repo>/dist/index.js"],
         "env": { "OKH_HOME": "T/okh-home" }
       }
     }
   }
   ```
   (Verify the exact key — `mcpServers` — against Copilot CLI's MCP config schema.)
3. **cwd = `T/workspace`** (empty scratch dir).
4. **Auth:** `GH_TOKEN`/`COPILOT_GITHUB_TOKEN` must be present in the environment.
   Because `COPILOT_HOME` is relocated per run, the stored interactive login is not
   available; headless auth relies on the token env var. This is a **prerequisite**.

## 7. Provider run (`provider/copilotProvider.ts`)

- Command: `copilot -p "<prompt>" --allow-all --model <config.model>` (verify the
  exact `--model` flag/values via `copilot help`).
- Env: `{ COPILOT_HOME, GH_TOKEN }`; cwd: `T/workspace`; enforce a per-run timeout.
- Capture stdout as the **transcript**; extract **tool calls** from the transcript
  or session log (verify the log format/location during implementation).
- Return `{ output: transcript, metadata: { workspace: T, okhHome, containerPath,
  originPath, toolCalls } }`.
- **Does not clean up** — assertions run afterward and read `metadata.workspace`.
  Cleanup is handled by `okh-eval clean` or left to the OS temp dir.

## 8. Deterministic checks (`assertions/*.ts`) — hard gate

Each is a `javascript` assertion (`(output, context)`) that reads
`context.providerResponse.metadata.workspace` and per-scenario `context.config`,
reusing `src/` parsers:

- **`tools-called`** — the required OKH tools appear in `metadata.toolCalls`.
- **`transcript`** — `mustContain` / `mustNotContain` regex on the transcript.
- **`okf-valid`** — new/changed `.md` in the knowledge module parses via
  `parseFrontmatter` + OKF rules (non-empty frontmatter `type`, citations present
  for sourced claims); `index.md` updated.
- **`memory-append`** — exactly one new dated, append-only entry in the memory
  module (prior entries unchanged).
- **`git-committed`** — the clone has a new commit and (for `git-auto`) the **bare
  origin received it** (verify by reading the origin's log or a fresh clone).

## 9. Judge & thresholds

- **Judge:** `llm-rubric` with the scenario's rubric + `threshold`. The grader
  provider is set via `defaultTest.options.provider` — an **independent model by
  default** (avoids self-grading bias, cheaper than routing through Copilot); it
  **may** be pointed at the Copilot-CLI provider if all judgments must route
  through Copilot CLI.
- **Overall pass** = all deterministic checks pass **AND** rubric score ≥ threshold.

## 10. Goal wiring

### Goal 1 — Regression across prompt changes and models
- **Prompt-change regression:** the provider always runs the freshly-built server
  (`dist/index.js`), so any change to `src/prompts/*` or `resources/discipline/*`
  flows into the eval. Run the suite before/after a change; compare reports.
- **Model matrix:** default **one** provider entry (single pinned model). For a
  sweep, add provider entries pointing at the same provider file with different
  `config.model`. promptfoo runs every scenario against each and reports per-model
  pass rates.
- **Stability:** rely on the rubric `threshold` and promptfoo `repeat` (Copilot CLI
  temperature is not directly controllable). Use pass-rate expectations rather than
  all-must-pass.

### Goal 2 — Prompt optimization
- Treat `resources/discipline/*.md` (and the builder wrappers in
  `src/prompts/index.ts`) as the optimizable artifact.
- A/B variants by running the suite against two OKH builds (git branches/worktrees)
  and comparing in **`promptfoo view`** (side-by-side scores per scenario). Promote
  the winner; delete the loser. Iterate.

## 11. Manual mode (`okh-eval.ts`)

- **`setup <scenario> [--backend local|git-auto]`** — calls `provision()` and
  prints: the workspace path, the exact `copilot` launch command (with env), the
  scenario prompt to paste, and an expected-outcome checklist derived from the
  test's assertions.
- **`check <workspace> --scenario <name>`** — runs the deterministic assertions
  against a workspace you drove by hand.
- **`list`** — list scenarios. **`clean`** — remove temp workspaces.

## 12. Scenario set

Happy paths for all five prompts plus guardrail negatives:

| Scenario | Prompt | Backend | Focus |
|---|---|---|---|
| `ask-grounded` | ask | local | grounded, cited answer |
| `ask-declines-when-absent` | ask | local | declines when not in KB (no hallucination) |
| `context-assembly` | context | local | compact, relevant working set; flags gaps |
| `learn-integrates` | learn | git-auto | valid OKF edit + `sync` commit to origin |
| `learn-rejects-trivial` | learn | local | okf-gate rejects non-goal info; no write |
| `remember-records` | remember | local | append-only dated memory entry |
| `remember-no-conclusions` | remember | local | records facts, does not synthesize |
| `reflect-insights` | reflect | local | cited, high-signal lessons; proposes updates |

Base fixtures (reused via `fixtureRef`):
- **`kb-hub`** — `local`; modules: knowledge + skills + tools + memory (seeded).
- **`git-hub`** — `git-auto`; modules: knowledge + memory (seeded), with a bare
  origin created at provision time.

## 13. Prerequisites & caveats

- **Prerequisites:** `npm run build` (the mcp-config points at `dist/index.js`);
  `GH_TOKEN`/`COPILOT_GITHUB_TOKEN` in the environment; `promptfoo` installed;
  Copilot CLI installed and authenticated for that token.
- **Cost:** ~1 agent call + 1 judge call per test × models × `repeat`; each Copilot
  CLI prompt consumes a premium request. Keep the default matrix small.
- **Non-determinism / flakiness:** rely on thresholds + `repeat`; **do not** put
  this suite in a required CI gate — run on demand / nightly.
- **Caching:** disabled for the agent provider.
- **To verify during implementation:** the exact `mcp-config.json` key
  (`mcpServers`), the `--model` flag name and accepted model IDs, and the
  transcript/session-log format used to extract tool calls (`copilot help`,
  `copilot help config`, `copilot help permissions`).

## 14. Out of scope

- `pr`-mode sync in the eval (needs a real GitHub remote + `gh`; already covered by
  unit tests).
- Multi-container "whole-hub" scan scenarios (can be added later).
- A separate promptfoo raw-model track (provider-agnostic regression) — possible
  future complement, not part of this harness.
- Putting the eval in required CI.
