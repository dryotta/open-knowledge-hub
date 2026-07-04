# Setting up Open Knowledge Hub

Open Knowledge Hub (OKH) is an [MCP](https://modelcontextprotocol.io) server. The
**hub** is the system; it manages **containers** (a folder, OS-synced folder, or
git repo), each holding typed **modules**. This guide installs OKH and runs
first-run onboarding. For a local dev build, see **[DEVELOPMENT.md](./DEVELOPMENT.md)**.

## Prerequisites

- **Node.js ≥ 18** (ships with `npx`).
- **git**.
- **[GitHub CLI](https://cli.github.com/) (`gh`)**, authenticated — only for
  `pr`-mode containers.

## Install

Add OKH to your MCP client (runs from GitHub via `npx`, builds on first launch):

```jsonc
{
  "mcpServers": {
    "open-knowledge-hub": {
      "command": "npx",
      "args": ["-y", "github:dryotta/open-knowledge-hub"]
      // "env": { "OKH_HOME": "/Users/me/.open-knowledge-hub" }
    }
  }
}
```

Copilot CLI: add it to `~/.copilot/mcp-config.json`, run `copilot`, confirm with
`/mcp`. `OKH_HOME` sets where the registry and cloned containers live (default
`~/.open-knowledge-hub`).

## Onboard

Once loaded, send:

> **Use the Open Knowledge Hub MCP and run onboard to set me up.**

Designed to route reliably on a cold start, in any client. The `onboard` flow
guides you through terminology, a **wake phrase** (default `hub`, saved via
`config`), and your **first container + modules** (`add` previews a plan before
changing anything). `onboard` is the init step — there is no separate one.

## Next

Address the hub by its wake phrase, e.g. `hub, remember that …`. See
**[USAGE.md](./USAGE.md)** for everyday prompts and **[README.md](./README.md)**
for the full tool reference.
