# Using Open Knowledge Hub

Open Knowledge Hub (OKH) is the **hub** — the system you address by a wake phrase.
The hub manages **containers** (a folder, an OS-synced folder, or a git repo), each
made of typed **modules** (`knowledge`, `skills`, `memory`, `llmwiki`).
Your agent does the thinking; OKH stores, validates, and syncs.

## How your prompt reaches the hub

Your agent decides which tools to call from their descriptions and the hub's
announced **wake phrase**. Address the hub with the wake phrase — by default
`hub` — for example: `hub, ask …` or `hub, run …`.

- The *cognitive flows* (`ask`, `context`, `run`, `sleep`) return instructions your
  agent then follows — they don't act on their own. Naming the hub matters most for
  these; without it, a request often won't reach OKH. `learn`, `remember`, `reflect`,
  and `dream` are module skills — `learn`/`remember`/`reflect` are invoked via
  `run { container, module, skill }`, and `dream` runs through the `sleep` flow.
- The *operational tools* (`inspect`, `add_container`, `add_module`, `sync`, `config`) act directly and
  usually route reliably even without the prefix.
- Most explicit option: clients with a prompt UI expose OKH's flows as pickable
  `/`-commands.

## Getting started

Say **`hub, help me get started`** to run the guided `onboard` flow. Or set up a
container directly:

- **From an existing folder:** `hub, add my folder ./notes as a knowledge container.`
- **From scratch:** `hub, create a new knowledge container in ./my-notes.`
- **From GitHub:** `hub, connect the repo https://github.com/me/my-notes.git.`
- **Add a module:** `hub, add a knowledge module called kb.`

**The confirmation step.** `add_container` never changes anything on disk on its own:
it first replies with a **plan** ("will create folder …, will initialize a manifest …").
Review it and confirm; your agent then re-runs it with `create:true` to apply.
`add_module` instead returns a short **workflow** — your agent understands the need,
proposes the module (with a `description` that says what it holds), confirms with you,
then applies with `create:true` and runs the type's `initialize` skill to populate it.
The module's **folder name is its identity** — there's no separate name — and modules
live as top-level folders in the container.

## Keeping module descriptions fresh

`inspect` routes work to modules using each module's `description`, so it should stay
accurate as content grows. Say **`hub, sleep`** (or `hub, sleep on my-notes`) to run the
`dream` consolidation pass: your agent reads each module's `index.md`, drafts a
routing-quality description, and persists it. You can also set one directly —
`hub, set kb's description to "auth flows and token lifecycle"` — which your agent
applies via `config { container, module, description }`.

## Organizing many skills

Use multiple `skills` modules when audience, ownership, access, or sync lifecycle
differs. Within one module, `index.md` defines its scope and folder taxonomy; group
skills by stable capability area at any depth. A folder with `SKILL.md` is a leaf,
so nested scripts, templates, and references stay attached to that skill. Skill
names must be unique only within their module.

## Choosing a wake phrase

The default is `hub`. To change it: `hub, call yourself brain.` — your agent
persists it via the `config` tool (`config { set: { wakePhrase: "brain" } }`). It
takes effect the next time your MCP client restarts. For the most reliable
routing, you can also rename this server's key in your MCP client config to the
same phrase (client-specific).

## Everyday use

- **Remember:** `hub, run remember on my memory module.`
- **Learn:** `hub, run learn on my knowledge module with this: session tokens use RS256.`
- **Ask:** `hub, what do we know about authentication?`
- **Ask across everything:** `hub, across all my containers, what do we know about X?`
- **Context:** `hub, assemble the context I need to build a login feature.`
- **Reflect:** `hub, run reflect on my memory module.`
- **Todos:** `hub, show my todos.` — the `todos` result includes the hosted browser
  URL for filtering, creating, completing, and reopening tasks.
- **Sync:** `hub, sync my container.` (commit + push for `auto`; push to shared branch for `shared`). When ready to publish: `hub, publish my changes as a PR.`
- **Shared skill (no module):** `hub, run the grilling skill to stress-test my plan.` — shared skills (`grilling`, `okf-writer`, `ingest`) run via `run { skill }` with no container/module.
- **Ingest documents:** `hub, ingest these lab PDFs into my Health module.` — give file paths/URLs or paste the content (OKH can't see chat attachments). The `ingest` skill extracts each source into cited candidates, proposes a routing plan, then folds them into the target module via `learn`/`remember`, respecting the module's scope contract. A module can opt in (during `initialize`) to **keeping a copy of each ingested document** under `./sources/<YYYY-MM>/`; `ingest` honors that policy and cites the retained copy.

`run` flows (`learn`, `remember`, `reflect`) are module skills — your agent follows
the returned instructions, edits files locally, and syncs the result. `sync` commits
and pushes to origin for `auto`-mode containers, or commits and pushes to the
configured shared branch (rebased onto origin/main) for `shared`-mode containers.
Call `sync { action: "publish-pr" }` when ready to open a pull request to main.
