# Using Open Knowledge Hub

Open Knowledge Hub (OKH) organizes your knowledge and capabilities into
**containers** (a folder, an OS-synced folder, or a git repo) made of typed
**modules** (`knowledge`, `skills`, `tools`, `memory`, `project`). Your agent does
the thinking; OKH stores, validates, and syncs.

## How your prompt reaches the hub

Your agent decides which tools to call from their descriptions and the hub's
announced **wake phrase**. Address the hub with the wake phrase — by default
`hub` — for example: `hub, remember that …`.

- Naming the hub matters most for the *cognitive* verbs (`ask`, `learn`,
  `remember`, `context`, `reflect`); without it, "remember that X" often looks
  like an ordinary request and won't reach OKH.
- The *operational* verbs (`inspect`, `add`, `sync`) usually route reliably even
  without the prefix.
- Most explicit option: clients with a prompt UI expose OKH's flows as pickable
  `/`-commands.

## Getting started

Say **`hub, help me get started`** to run the guided `onboard` flow. Or set up a
hub directly:

- **From an existing folder:** `hub, add my folder ./notes as a knowledge hub.`
- **From scratch:** `hub, create a new knowledge hub in ./my-notes.`
- **From GitHub:** `hub, connect the repo https://github.com/me/my-hub.git.`
- **Add a module:** `hub, add a knowledge module called kb.`

**The confirmation step.** `add` never changes anything on disk on its own. It
first replies with a **plan** ("will create folder …, will initialize a
manifest …"). Review it and confirm; your agent then re-runs `add` to apply. This
is why the first `add` shows a plan instead of doing the work immediately.

## Choosing a wake phrase

The default is `hub`. To change it: `hub, call yourself brain.` — your agent
persists it via the `config` tool (`config { set: { wakePhrase: "brain" } }`). It
takes effect the next time your MCP client restarts. For the most reliable
routing, you can also rename this server's key in your MCP client config to the
same phrase (client-specific).

## Everyday use

- **Remember:** `hub, remember that the login endpoint 500'd at 14:05 UTC.`
- **Learn:** `hub, learn this: session tokens use RS256, keys rotate weekly.`
- **Ask:** `hub, what do we know about authentication?`
- **Ask across everything:** `hub, across all my hubs, what do we know about X?`
- **Context:** `hub, assemble the context I need to build a login feature.`
- **Reflect:** `hub, reflect on my memory from this week and propose updates.`
- **Sync:** `hub, sync my hub.` (commit + push) or `hub, open a PR with my changes.`

Writing flows (`learn`, `remember`, `reflect`) edit files locally; your agent
summarizes the change and asks before syncing. `sync` commits + pushes (`auto`
containers) or opens a pull request (`pr` containers).
