# open-knowledge-hub

Open Knowledge Hub is an MCP server for organizing agent-accessible knowledge and
capabilities into containers of typed modules.

The canonical documentation is bundled with the server under
[`resources/docs/`](resources/docs/index.md):

- [Setup](resources/docs/getting-started.md)
- [Concepts and routing](resources/docs/concepts.md)
- [Usage examples](resources/docs/usage.md)
- [Reference](resources/docs/reference.md)
- [Resource architecture](resources/docs/resources.md)
- [Development](resources/docs/development.md)

## Publishing knowledge to a GitHub wiki

A git+github.com container can mirror its `knowledge` modules to the repo's
GitHub wiki. Enable the wiki feature once in repo Settings → Features, then:

    config { "container": "<name>", "set": { "wiki": { "enabled": true } } }

Run `sync` to commit the scaffolded workflow; publishing then runs in CI on every
push to `main`. See [`resources/docs/wiki.md`](resources/docs/wiki.md) for details.

License: MIT.
