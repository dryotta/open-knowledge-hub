# Developing Open Knowledge Hub

Build, test, and run a local OKH server. To install the released server, see
**[SETUP.md](./SETUP.md)**.

## Prerequisites

- **Node.js ≥ 18**, **git** (tests/eval run real git against temp repos).
- **[GitHub CLI](https://cli.github.com/) (`gh`)**, authenticated — for `pr`-mode
  containers and the live eval.

## Build & test

```bash
git clone https://github.com/dryotta/open-knowledge-hub.git
cd open-knowledge-hub
npm install
npm run build      # compile to dist/
npm run typecheck  # type-only check
npm test           # vitest (real git against temp repos)
npm run dev        # run from source via tsx
```

## Eval (live, optional)

The `eval/` harness runs the built server in Copilot CLI, so **rebuild before
evaluating**.

```bash
npm run typecheck:eval  # type-check eval sources
npm run test:eval       # eval unit tests
npm run eval:validate   # validate promptfoo config
npm run eval            # full live run (Copilot CLI; premium usage)
```

See **[eval/README.md](./eval/README.md)** for automated and manual eval runs.

## Run a dev build in your client

Build, then point your client at the local `dist/index.js`:

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

Use an absolute path (Windows: `"D:\\...\\dist\\index.js"`). Rebuild and restart
the client after changes. Point `OKH_HOME` at a scratch dir to isolate dev data.

## Architecture

Layering: `exec` → `git`/`gh` → `registry` → `container` → `modules` → `prompts`
→ `server`. See **[CONTEXT.md](./CONTEXT.md)** and **[docs/adr/](./docs/adr/)**.
