# OKH E2E Harness (GitHub Copilot CLI)

Exercises the real OKH MCP server **inside GitHub Copilot CLI** against real
fixture containers. Design: `docs/superpowers/specs/2026-07-02-okh-e2e-copilot-cli-design.md`.

Two modes, one set of scenarios (`scenarios/*/test.yaml`):
- **Automated** — promptfoo drives a custom Copilot-CLI provider, applies
  deterministic `javascript` assertions + a **Copilot-CLI judge**, and reports (this doc).
- **Manual & exploratory** — run cases by hand and inspect results yourself:
  see **[MANUAL-TESTING.md](./MANUAL-TESTING.md)**.

## Prerequisites

- `npm run build` — the harness launches the **built** server (`dist/index.js`).
- `copilot` installed and authenticated. The harness runs each case in an isolated
  `COPILOT_HOME`, so auth must resolve independently of that directory:
  - **macOS & Windows — no token needed.** The CLI login lives in the OS credential
    store (macOS Keychain / Windows Credential Manager), not in `COPILOT_HOME`, so a
    logged-in machine authenticates the spawned `copilot` automatically. (Verified on
    Windows; macOS uses the same keychain-backed mechanism.)
  - **Linux / CI — set a token.** On hosts that store the login *inside*
    `COPILOT_HOME` (which the harness wipes per run), provide a token env var:
    `COPILOT_GITHUB_TOKEN` or `GH_TOKEN`.
- The **judge also runs through GitHub Copilot CLI** (`eval/assertions/judge.ts`) —
  **no external model/API key**. Each scenario makes ~2 Copilot calls: one for the
  agent (via the provider) and one for the judge (grades the transcript vs the rubric).
- `promptfoo` (installed as a devDependency).

## Automated eval

```bash
npm run build
$env:GH_TOKEN = "..."         # Linux/CI only; skip on logged-in macOS/Windows
npm run eval:validate         # structural promptfoo validation via node --import tsx
npm run eval                  # runs promptfoo under `node --import tsx` (see note below)
npm run eval:view             # open the report + side-by-side comparison UI
```

> **Validation:** Use `npm run eval:validate` for structural validation. It launches
> promptfoo via `node --import tsx`, matching `npm run eval`, so the TypeScript
> provider can keep NodeNext `.js` import specifiers.

**Model matrix (goal 1):** add more `providers` entries in `promptfooconfig.yaml`,
each pointing at `file://provider/copilotProvider.ts` (paths are relative to `eval/`)
with a different `config.model`. Default is a single pinned model.

**Optimization (goal 2):** run the suite against two OKH builds (git branches),
then compare in `npm run eval:view`.

## Manual & exploratory testing

Run the scenarios by hand in Copilot CLI, inspect results yourself, and do
free-form exploration. Provisioned runs are recorded, so follow-up commands are
path-free: `setup <scenario>` → `enter` → `check` → `clean`. See
**[MANUAL-TESTING.md](./MANUAL-TESTING.md)**.

## Onboarding scenarios

`provision` (per-scenario var) selects the starting state:
- `registered` (default) — the fixture is pre-registered as a container.
- `empty` — empty registry + empty workspace (agent adds from scratch or a URL).
- `unregistered-local` — the fixture sits in the workspace, unregistered, for the
  agent to `add`.

`onboard-add-github` clones the **private** repo `dryotta/okh-eval-hub`. Cloning a
private repo relies on the machine's `gh` credential helper (macOS/Windows) or a
token with `repo` read (Linux/CI). No push/sync is exercised.

## Caveats

- Each run consumes premium requests: **2 Copilot CLI calls per test × models** — one
  for the agent, one for the judge. Keep the default matrix small.
- Copilot CLI temperature isn't directly controllable — rely on judge thresholds
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
  `npm run eval:validate` passes.
- Validated flows: `remember` (append-only memory entry), `learn`+`sync` (OKF change
  committed & pushed to the git-auto origin), and `learn` correctly REJECTING
  out-of-scope input (no write).

## Open items / notes

- The judge runs through Copilot CLI (`eval/assertions/judge.ts` → `runJudgeCriteria`), so the
  automated run needs **no external grader key** — only Copilot CLI auth. Deterministic
  assertions and the manual `check` need no judge at all.
- On Windows, promptfoo may print a libuv assertion on process exit **after** a
  successful run — cosmetic.
- If a future Copilot CLI version renders tool calls differently, adjust
  `extractToolCalls`; on hosts that store the login inside `COPILOT_HOME` (e.g.
  Linux/CI), set a token env var (`GH_TOKEN`/`COPILOT_GITHUB_TOKEN`).
