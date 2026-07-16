---
title: Getting started
description: Install Open Knowledge Hub, connect it to an MCP client, and complete first-run onboarding.
---

# Getting started

## Prerequisites

- Node.js 18 or newer
- `git`
- Authenticated [GitHub CLI](https://cli.github.com/) (`gh`) only for git
  containers using `shared` sync or publishing pull requests

## Install

Add OKH to the MCP client's server configuration:

```jsonc
{
  "mcpServers": {
    "open-knowledge-hub": {
      "command": "npx",
      "args": ["-y", "github:dryotta/open-knowledge-hub"],
      // "env": { "OKH_HOME": "/Users/me/.open-knowledge-hub" }
    }
  }
}
```

For Copilot CLI, place the entry in `~/.copilot/mcp-config.json`, start
`copilot`, and confirm the connection with `/mcp`.

`OKH_HOME` defaults to `~/.open-knowledge-hub`. It holds preferences, the
container registry, and clones managed by OKH. Each server instance also starts a
loopback-only web UI on a dynamic port. Set `OKH_WEB_PORT` only when a fixed port
is needed.

## Onboard

Once the server is connected, say:

> Use the Open Knowledge Hub MCP and run onboard to set me up.

`onboard` explains the model, chooses a wake phrase (default `hub`), and guides
creation or registration of the first container and modules. `add_container`
previews its plan before `create: true`; `add_module` returns a workflow that also
includes the module type's `initialize` skill when one exists.

After onboarding, address the server by its wake phrase, for example:

> hub, what do we know about authentication?

Call `help` for questions about OKH itself. See
[usage](okh://docs/usage.md) for common workflows.
