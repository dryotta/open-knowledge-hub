# Using Open Knowledge Hub

Open Knowledge Hub (OKH) is the **hub** — the system you address by a wake phrase.
The hub manages **containers** (a folder, an OS-synced folder, or a git repo), each
made of typed **modules** (`knowledge`, `skills`, `tools`, `memory`, `project`).
Your agent does the thinking; OKH stores, validates, and syncs.

## How your prompt reaches the hub

Your agent decides which tools to call from their descriptions and the hub's
announced **wake phrase**. Address the hub with the wake phrase — by default
`hub` — for example: `hub, ask …` or `hub, run …`.

- The *cognitive flows* (`ask`, `context`, `run`) return instructions your agent
  then follows — they don't act on their own. Naming the hub matters most for
  these; without it, a request often won't reach OKH. `learn`, `remember`, and
  `reflect` are module skills, invoked via `run { container, module, skill }`.
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
proposes the module, confirms with you, then applies with `create:true` and runs the
type's `initialize` skill to populate it.

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
- **Sync:** `hub, sync my container.` (commit + push) or `hub, open a PR with my changes.`
- **Shared skill (no module):** `hub, run the grilling skill to stress-test my plan.` — shared skills (`grilling`, `okf-writer`, `ingest`) run via `run { skill }` with no container/module.
- **Ingest documents:** `hub, ingest these lab PDFs into my Health module.` — give file paths/URLs or paste the content (OKH can't see chat attachments). The `ingest` skill extracts each source into cited candidates, proposes a routing plan, then folds them into the target module via `learn`/`remember`, respecting the module's scope contract.

`run` flows (`learn`, `remember`, `reflect`) are module skills — your agent follows
the returned instructions, edits files locally, and asks before syncing. `sync`
commits + pushes (`auto` containers) or opens a pull request (`pr` containers).
