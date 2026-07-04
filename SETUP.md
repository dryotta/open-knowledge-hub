# Setting up Open Knowledge Hub

Open Knowledge Hub (OKH) is an [MCP](https://modelcontextprotocol.io) server —
the **hub** is the system itself; it manages your **containers** (a folder, an
OS-synced folder, or a git repo), each made of typed **modules**. This guide
installs the hub in your MCP client and walks you through first-run onboarding.

> Building or running a local development version instead? See
> **[DEVELOPMENT.md](./DEVELOPMENT.md)**.

## Prerequisites

- **Node.js ≥ 18** (ships with `npx`).
- **git** — clone/commit/branch/push.
- **[GitHub CLI](https://cli.github.com/) (`gh`)**, authenticated — only for
  `pr`-mode containers (opening pull requests). The server stores no credentials.

## Install

Add OKH to your MCP client. It runs straight from GitHub via `npx` and builds on
first launch:

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

- Copilot CLI: add the block to `~/.copilot/mcp-config.json`, then run `copilot`
  and confirm the server loads with `/mcp`.
- Other clients: add the same `mcpServers` entry to that client's MCP config.
- `OKH_HOME` (optional) sets where the hub keeps its registry and cloned
  containers; it defaults to `~/.open-knowledge-hub`.

## Onboard (initialize the system)

Once the server is loaded, send this message to start guided setup:

> **Use the Open Knowledge Hub MCP and run onboard to set me up.**

This phrase is designed to route reliably on a cold start, in any client: it
names the server, says "MCP" so the agent reaches for the tools, and uses the
`onboard` flow by name. (`onboard` *is* the initialize-the-system flow — there is
no separate init step.)

The `onboard` flow guides you, one step at a time, through:

1. **Intro and terminology** — what the hub, containers, and modules are.
2. **Wake phrase** — pick a short word to address the hub (default `hub`); it is
   saved via the `config` tool.
3. **Your first container and modules** — set one up from an existing folder, a
   new folder, or a git repository. `add` always previews a plan and only changes
   anything after you confirm.

## After onboarding

Address the hub by its wake phrase (default `hub`) — for example
`hub, remember that …` or `hub, what do we know about …?`. See
**[USAGE.md](./USAGE.md)** for the everyday prompts, and **[README.md](./README.md)**
for the full tool/flow reference.
