---
title: Development
description: Build, test, inspect, and extend Open Knowledge Hub locally.
---

# Development

## Build and test

```bash
git clone https://github.com/dryotta/open-knowledge-hub.git
cd open-knowledge-hub
npm install
npm run build
npm run typecheck
npm test
npm run dev
```

The test suite uses real git repositories in temporary directories. `npm run dev`
prints the loopback web origin to stderr.

Eval commands:

```bash
npm run typecheck:eval
npm run test:eval
npm run eval:validate
npm run eval
```

The live eval launches `dist/index.js`, so rebuild first. `npm run manual` opens the
manual eval workflow. Additional harness details remain co-located in
`eval/README.md`.

## MCP Inspector

```bash
npm run inspect
npm run inspect:dev
```

The Inspector can list and call all tools, direct resources, and resource templates.
Set `OKH_HOME` to a scratch directory to isolate test data.

## Local client configuration

Build, then point the MCP client at the absolute `dist/index.js` path:

```json
{
  "mcpServers": {
    "open-knowledge-hub": {
      "command": "node",
      "args": ["/absolute/path/to/open-knowledge-hub/dist/index.js"],
      "env": { "OKH_HOME": "/tmp/okh-dev" }
    }
  }
}
```

Use escaped backslashes on Windows. Rebuild and restart the client after changes.

## Architecture

The principal layers are:

```text
exec -> git/gh -> registry -> container -> modules
                                      -> resources
                                      -> prompts/todos
                                      -> MCP + loopback web servers
```

- `src/resources/` owns MCP resource providers, URI construction, MIME handling,
  safe module reads, bounded embedded-resource selection, and the model-read adapter.
- `resources/docs/` is canonical current documentation.
- `resources/instructions/` contains reusable, non-runnable guidance.
- `resources/module-types/` contains module loaders' scaffolds and built-in skills.
- `resources/prompts/` and `resources/tool-meta/` hold agent-facing runtime text.
- `docs/adr/` and `docs/superpowers/` are historical engineering records, not
  canonical product documentation and not exposed as docs resources.

See [resource architecture](okh://docs/resources.md) before adding a resource family.
