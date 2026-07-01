# TypeScript + official MCP SDK, distributed via npx

We will build the server in **TypeScript** on the official `@modelcontextprotocol/sdk`,
distributed via `npx`. The deciding factor was **end-user installation friction**: Node/`npx`
is more ubiquitous than Python's `uv`/`uvx`, is bundled with npm, and is the de-facto default
in MCP client setup docs — so there is less to go wrong before the server starts. The server
has no compiled/native dependencies (git operations shell out to `git`/`gh`), so there is no
node-gyp risk.

## Considered Options

- **Python + FastMCP via uvx** (rejected): authoring ergonomics are excellent and `uvx` is clean
  *once `uv` is installed*, but `uv` is an extra bootstrap prerequisite not bundled with system
  Python, and the pip/venv fallback path exposes users to classic Python-env issues (multiple
  Pythons, PATH, PEP 668). This was a close call, initially chosen then reversed specifically on
  the install-friction criterion.
- **Go single binary** (rejected): lowest runtime friction but weaker/less-idiomatic MCP tooling
  and slower iteration for a prompt-and-git-heavy server.

## Consequences

- `git` and the `gh` CLI are runtime prerequisites regardless of language; the README must ship
  troubleshooting guidance for installing and authenticating them.
