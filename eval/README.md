# OKH E2E Harness (GitHub Copilot CLI)

Exercises the real OKH MCP server **inside GitHub Copilot CLI** against real
fixture containers. Design: `docs/superpowers/specs/2026-07-02-okh-e2e-copilot-cli-design.md`.

Two modes, one set of scenarios (`eval/scenarios/*/test.yaml`):
- **Automated** — promptfoo drives a custom Copilot-CLI provider, applies
  deterministic `javascript` assertions + an `llm-rubric` judge, and reports.
- **Manual** — provision a ready workspace and run Copilot CLI by hand.

## Prerequisites

- `npm run build` — the harness launches the **built** server (`dist/index.js`).
- `copilot` installed and a token in the environment: `GH_TOKEN` or
  `COPILOT_GITHUB_TOKEN` (required — the harness uses an isolated `COPILOT_HOME`,
  so the interactive login is not visible).
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
each pointing at `file://eval/provider/copilotProvider.ts` with a different
`config.model`. Default is a single pinned model.

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

## Verify-points (confirm against your Copilot CLI version)

- `mcp-config.json` key is `mcpServers` (see `provision.ts`) — check `copilot help config`.
- The `--model` flag name and accepted model IDs — check `copilot help` / `/model`.
- The transcript/session-log rendering of MCP tool calls — `extractToolCalls`
  (in `copilot.ts`) is best-effort; adjust its patterns if your version differs.
- **promptfoo `file://` path resolution:** the config uses repo-root-relative
  paths (e.g. `file://eval/provider/copilotProvider.ts`, and `file://eval/assertions/…`
  inside scenario `test.yaml`), assuming promptfoo resolves them relative to the
  cwd when run as `promptfoo eval -c eval/promptfooconfig.yaml` from the repo root.
  If your promptfoo resolves `file://` relative to the **config file's directory**
  instead, drop the `eval/` prefix (e.g. `file://provider/…`, `file://scenarios/*/test.yaml`,
  and `file://../assertions/…` in scenarios). Confirm on the first live run.
- Whether promptfoo TS providers/assertions load `../src/*.ts` imports via its
  Node loader; if not, build and point imports at `dist/*.js` (see the plan's
  "Note on imports from `src/`").
