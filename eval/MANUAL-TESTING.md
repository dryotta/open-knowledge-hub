# Manual & Exploratory E2E Testing (GitHub Copilot CLI)

How to run the OKH e2e scenarios **by hand** in GitHub Copilot CLI, inspect the
results yourself, and do free-form exploratory testing against the real MCP
server. For the fully automated pipeline see [`README.md`](./README.md).

All commands run from the repository root (`open-knowledge-hub/`), examples in
PowerShell (Windows).

---

## 0. Prerequisites & setup

See [Prerequisites in `README.md`](./README.md#prerequisites). In short: `npm install`,
then `npm run build` (the harness launches the built `dist/index.js` — re-run after any
`src/` change), and an authenticated `copilot`. **No external model/API key** — the agent
and judge both run through Copilot CLI.

---

## 1. List the scripted cases

```powershell
npm run eval:setup -- list
```

Scenarios: `ask-grounded`, `ask-declines-when-absent`, `context-assembly`,
`context-includes-skills-tools`, `learn-integrates`, `learn-rejects-trivial`,
`remember-records`, `remember-no-conclusions`, `reflect-insights`.

---

## 2. Provision an isolated workspace for one case

```powershell
npm run eval:setup -- setup ask-grounded
```

This copies the scenario's fixture into a throwaway temp **Root** and builds an
isolated `COPILOT_HOME` whose `mcp-config.json` points Copilot at the OKH server
running against an isolated `OKH_HOME`. The run is **recorded**, so the follow-up
commands below need no path. It prints:

- **Root** / **Workspace** paths (informational — you no longer copy them),
- the `enter` / headless-run commands,
- an **expected-outcome checklist**,
- the path-free **check** and **clean** commands.

Nothing is spawned yet; no premium requests are used by `setup`.

---

## 3. Run the case — interactively

Drop straight into an interactive session in the isolated env (no env vars, no
`Set-Location`, no pasted path):

```powershell
npm run eval:setup -- enter
```

`enter` targets the most-recently provisioned run; pass a scenario name to pick a
specific one (`npm run eval:setup -- enter ask-grounded`) or `--model <M>` to
override the model. Inside the session:

- `/mcp` — confirm **open-knowledge-hub** is loaded and list its tools.
- Paste the scenario prompt (from `eval\scenarios\<name>\test.yaml` → `vars.prompt`).
  Example (ask-grounded):
  > Use the open-knowledge-hub MCP tools. In container "kb-hub", answer strictly
  > from its knowledge module: How does auth work?
- Watch it call the OKH tool(s) and produce an answer.

(The headless `copilot -p '…'` command printed by `setup` remains available if you
prefer a one-shot run.)

---

## 4. Inspect the results manually

Judge the **answer quality** yourself against the printed checklist (e.g.
ask-grounded expects: uses `ask`, mentions tokens, cites the Auth concept, invents
nothing).

Then run the objective side-effect checks — no path needed (resolves the most
recent run; pass a scenario name to target a specific one):

```powershell
npm run eval:setup -- check
```

`check` runs only the deterministic assertions (`okf-valid`, `memory-append`,
`git-committed`, `module-unchanged`). Answer grounding/quality is what you eyeball
here (the automated `npm run eval` adds a Copilot-CLI judge for that).

The explicit form still works if you want to point at a specific directory:

```powershell
npm run eval:setup -- check <root> --scenario ask-grounded
```

---

## 5. Clean up

```powershell
npm run eval:setup -- clean
```

`clean` removes the most-recent run's temp directory and drops it from the run
state; pass a scenario name to clean a specific one, or an explicit path
(`npm run eval:setup -- clean <root>`) as before. Repeat steps 2–5 for other
cases. Good ones to watch interactively:

- **`learn-integrates`** — the agent writes OKF knowledge and calls `sync`, which
  commits **and pushes** to a bare git origin (`git-committed` verifies it).
- **`learn-rejects-trivial`** — the okf-learn gate should refuse to store junk
  ("the sky is blue"); `module-unchanged` verifies nothing was written.

---

## 6. Exploratory (free-form) testing

### Option A — poke at a seeded fixture

Provision the rich `kb-hub` fixture (knowledge + skills + tools + memory), open an
interactive session, and throw your own prompts at it:

```powershell
npm run eval:setup -- setup context-assembly    # uses the kb-hub fixture
npm run eval:setup -- enter                      # interactive session, isolated env
```

Prompt ideas to probe behavior and edge cases:

- **ask** — "what does auth use?" vs. something absent (e.g. vacation policy) →
  should **decline**, not fabricate.
- **context** — "assemble context to debug a CSV-parsing test" → should surface the
  *skill* and *tool*, not just knowledge.
- **learn** — a genuinely useful fact (should integrate; then say "sync") vs. an
  irrelevant fact (gate should **reject**).
- **remember** then **reflect** — record a couple of observations, then ask it to
  reflect → look for cited, recurring-pattern insights.
- **Adversarial** — prompt-injection hidden in a question; ambiguous
  container/module; ask it to rewrite an existing memory entry (should stay
  append-only).

After each, inspect `"<Root>\okh-home\containers\kb-hub"` (files + `git`) to see
exactly what happened, then `npm run eval:setup -- clean` when done.

### Option B — dogfood against a real hub

Wire OKH into your **normal** Copilot CLI and use it for real. Add to
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

Then run `copilot` anywhere and use `ask` / `context` / `learn` / `remember` /
`reflect` plus `inspect` / `add` / `sync` against your own containers. `/mcp`
confirms it's loaded; `/env` shows all loaded servers.

---

## Notes

- Each interactive turn consumes premium requests.
- Fixture workspaces are disposable temp directories — mutate them freely, then `clean`.
- Automated-run caveats and verified-behavior notes live in [`README.md`](./README.md).
