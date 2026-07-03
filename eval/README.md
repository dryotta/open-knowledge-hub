# OKH E2E Harness (GitHub Copilot CLI)

Exercises the real OKH MCP server **inside GitHub Copilot CLI** against real
fixture containers. Design: `docs/superpowers/specs/2026-07-02-okh-e2e-copilot-cli-design.md`.

Two modes, one set of scenarios (`eval/scenarios/*/test.yaml`):
- **Automated** — promptfoo drives a custom Copilot-CLI provider, applies
  deterministic `javascript` assertions + an `llm-rubric` judge, and reports.
- **Manual** — provision a ready workspace and run Copilot CLI by hand.

## Prerequisites

- `npm run build` — the harness launches the **built** server (`dist/index.js`).
- `copilot` installed and authenticated. The harness uses an isolated
  `COPILOT_HOME`, so auth must come from the OS credential store (verified to work
  on Windows) or a token env var (`COPILOT_GITHUB_TOKEN`/`GH_TOKEN`) on hosts that
  store the login inside `COPILOT_HOME`.
- For the judge: an independent grader model key (e.g. `OPENAI_API_KEY`), or edit
  `defaultTest.options.provider` in `promptfooconfig.yaml`.
- `promptfoo` (installed as a devDependency).

## Automated eval

```bash
npm run build
$env:GH_TOKEN = "..."         # PowerShell; or export on bash
npm run eval                  # promptfoo eval -c eval/promptfooconfig.yaml --no-cache
npm run eval:view             # open the report + side-by-side comparison UI
```

**Model matrix (goal 1):** add more `providers` entries in `promptfooconfig.yaml`,
each pointing at `file://provider/copilotProvider.ts` (paths are relative to `eval/`)
with a different `config.model`. Default is a single pinned model.

**Optimization (goal 2):** run the suite against two OKH builds (git branches),
then compare in `npm run eval:view`.

## Manual mode

```bash
npm run build
npm run eval:setup -- list
npm run eval:setup -- setup ask-grounded            # prints workspace + copilot command + checklist
# ...run the printed `copilot -p ...` command, eyeball the answer against the checklist...
npm run eval:setup -- check <root> --scenario ask-grounded   # re-run objective file/git checks
npm run eval:setup -- clean <root>
```

## Caveats

- Each run consumes premium requests (1 agent call + 1 judge call per test × models).
- Copilot CLI temperature isn't directly controllable — rely on rubric thresholds
  (and promptfoo `repeat`). **Do not** gate required CI on this suite.
- Response caching is disabled for the agent provider (`--no-cache`).

## Verified against a live run (Windows, Copilot CLI + this OKH build)

Confirmed end-to-end by running real `copilot -p` against provisioned containers
(manual mode) and checking side-effects:

- `mcp-config.json` uses the `mcpServers` key; Copilot loads the OKH server from the
  isolated `COPILOT_HOME` and authenticates via the OS credential store.
- `--model claude-sonnet-4.5` is accepted.
- MCP tool calls render as `● <Title> (MCP: open-knowledge-hub) · args`;
  `extractToolCalls` (in `copilot.ts`) parses that form.
- promptfoo resolves `file://` paths **relative to the config file's dir (`eval/`)** —
  hence `file://provider/…`, `file://assertions/…`, `file://scenarios/*/test.yaml`.
  `promptfoo validate -c eval/promptfooconfig.yaml` passes.
- Validated flows: `remember` (append-only memory entry), `learn`+`sync` (OKF change
  committed & pushed to the git-auto origin), and `learn` correctly REJECTING
  out-of-scope input (no write).

## Open items / notes

- The `llm-rubric` judge needs a grader-model key (e.g. `OPENAI_API_KEY`) or a
  reachable `defaultTest.options.provider`; without it the automated run fails at
  grading. The deterministic assertions and the manual `check` need no judge.
- On Windows, promptfoo may print a libuv assertion on process exit **after** a
  successful run — cosmetic.
- If a future Copilot CLI version renders tool calls differently, adjust
  `extractToolCalls`; if it stores the login inside `COPILOT_HOME`, set a token env var.
