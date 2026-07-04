# Developing Open Knowledge Hub

How to build, test, and run a local development version of the OKH MCP server.
For installing the released server in an MCP client, see **[SETUP.md](./SETUP.md)**.

## Prerequisites

- **Node.js ≥ 18**.
- **git** — the test and eval suites run real git against temporary repos.
- **[GitHub CLI](https://cli.github.com/) (`gh`)**, authenticated — for
  `pr`-mode containers and the live eval harness.

## Clone and install

```bash
git clone https://github.com/dryotta/open-knowledge-hub.git
cd open-knowledge-hub
npm install
```

## Build, test, and type-check

```bash
npm run build      # compile TypeScript to dist/
npm run typecheck  # type-only check (no emit)
npm test           # vitest (uses real git against temp repos)
npm run dev        # run the server from source via tsx
```

## Eval (optional, live)

The `eval/` harness exercises the built server inside GitHub Copilot CLI. It
launches `dist/index.js`, so **run `npm run build` after any source change**
before evaluating.

```bash
npm run typecheck:eval  # type-check the eval sources
npm run test:eval       # eval unit tests (vitest)
npm run eval:validate   # structural promptfoo config validation
npm run eval            # full live e2e run (spawns Copilot CLI; premium usage)
```

See **[eval/README.md](./eval/README.md)** for prerequisites, cost, and
`eval/MANUAL-TESTING.md` for manual/exploratory runs.

## Install the development version in your MCP client

Build first (`npm run build`), then point your client at the local
`dist/index.js` instead of the published package:

```json
{
  "mcpServers": {
    "open-knowledge-hub": {
      "command": "node",
      "args": ["/absolute/path/to/open-knowledge-hub/dist/index.js"],
      "env": { "OKH_HOME": "/Users/me/.open-knowledge-hub" }
    }
  }
}
```

- Use an absolute path to your local checkout's `dist/index.js` (on Windows,
  e.g. `"D:\\work\\open-knowledge-hub\\dist\\index.js"`).
- Rebuild (`npm run build`) after changes and restart the client to pick them up.
- Point `OKH_HOME` at a scratch directory to keep dev containers separate from
  any real hub.

For Copilot CLI, add the block to `~/.copilot/mcp-config.json`; `/mcp` confirms
the server is loaded. Then onboard with the phrase from **[SETUP.md](./SETUP.md)**.

## Architecture

Layering: `exec` → `git`/`gh` → `registry` → `container` (manifest + service) →
`modules` (loaders) → `prompts` → `server`. See **[CONTEXT.md](./CONTEXT.md)** for
the glossary and **[docs/adr/](./docs/adr/)** for design decisions.
