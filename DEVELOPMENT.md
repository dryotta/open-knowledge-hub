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

## Eval (live)

The `eval/` harness runs the built server in Copilot CLI, so **rebuild before
evaluating**.

```bash
npm run typecheck:eval  # type-check eval sources
npm run test:eval       # eval unit tests
npm run eval:validate   # validate promptfoo config
npm run eval            # full live run (Copilot CLI; premium usage)
```

See **[eval/README.md](./eval/README.md)** for automated and manual eval runs.

## Inspect with MCP Inspector

The server speaks **stdio**, so the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
spawns it as a subprocess. Two scripts are provided:

```bash
npm run inspect      # build, then inspect dist/index.js
npm run inspect:dev  # inspect src/index.ts directly (no build) via tsx
```

Either opens a web UI (a `localhost` URL with an auth token) to list and call the
operational tools (`ask`, `add`, `sync`, `config`, `inspect`) and flows (`context`,
`learn`, `remember`, `reflect`, `onboard`). Set `OKH_HOME` to a scratch dir to
isolate data, e.g. `OKH_HOME=/tmp/okh npm run inspect`.

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

## Test client capabilities

Build and restart the MCP server, then call `capabilities` with no arguments.

- In a terminal client, verify the text table reports unsupported,
  `advertised_only`, and `not_exercised` states explicitly. Advertised sampling
  and elicitation are reported `advertised_only` on a normal scan; to exercise
  them (and legacy task cancellation) live, the client must support task-augmented
  tool calls — issue `action: "task_cancel"` as a task, cancel that task from the
  client, then call `action: "report"` (with the returned `runId`) to confirm the
  cancellation probe passes.
- In an MCP Apps-capable GUI host, verify the App renders, reflects host theme,
  changes its requested size, calls back to the same server, and refreshes the
  normalized report.
- The diagnostic must never print root paths, generated sampling text, elicited
  values, or sampling tool inputs.

Use `npm run inspect` for resource/tool metadata checks. Inspector does not
replace validation in an actual MCP Apps host.

## Architecture

Layering: `exec` → `git`/`gh` → `registry` → `container` → `modules` → `prompts`
→ `server`. See **[CONTEXT.md](./CONTEXT.md)** and **[docs/adr/](./docs/adr/)**.
