---
title: MCP resource architecture
description: Design rationale, URI contract, security rules, compatibility limits, and extension guide for OKH resource providers.
---

# MCP resource architecture

## Why resources

MCP resources are passive, application-driven context. They complement OKH tools:
tools route or mutate work; resources let clients browse and read hub content,
documentation, and reusable instructions without exposing host filesystem paths.

OKH initially registers three provider families:

1. `containers` - dynamic container/module hierarchy and safe module-file reads.
2. `docs` - canonical product documentation bundled with the package.
3. `instructions` - reusable guidance linked by module-type skills.

Each provider implements the small `ResourceProvider` contract in
`src/resources/types.ts`: an `id`, `register(server)`, bounded
`read(uri, { maxBytes? })`, and optionally `resolveLink(uri)` when its resources may be
declared as skill dependencies. The same provider read powers both protocol
`resources/read` and the model-controlled adapter. Providers must reject a bounded read
before returning content over `maxBytes`. The composition root is
`src/resources/index.ts`; add future providers there without coupling them to tool
registration.

## URI contract

OKH uses the custom RFC 3986 scheme `okh://` because reads are mediated by the MCP
server. It does not use `https://` for server-only content or leak Windows/POSIX
filesystem paths as resource identifiers.

```text
okh://containers
okh://containers/{container}
okh://containers/{container}/{module}
okh://containers/{container}/{module}/files/{path}
okh://docs/{path}
okh://instructions/{path}
```

Template values are percent-encoded. A module file path is encoded as one template
segment, then decoded once and validated as a relative POSIX path.

## Discovery and progressive disclosure

Canonical docs and instructions are fixed direct resources. The container collection
root is direct; container and module instances come from templates with list
callbacks. The module resource lists its visible files as resource URIs. The file
template intentionally has no list callback, preventing a large hub from flattening
every file into the SDK's unpaginated high-level `resources/list` response.

The server advertises `resources.listChanged`. Container creation, module creation,
and sync send list-changed notifications. Subscriptions are not advertised: SDK
v1.29.0's high-level `McpServer` does not implement subscribe/unsubscribe or updated
notifications.

## Client compatibility and model access

MCP resources are application-driven: registering a resource does not guarantee that a
host exposes `resources/read` to its model. A `resource_link` gives a capable client a
URI to fetch; it does not contain the resource body and is not an instruction to use a
filesystem or web fetcher.

GitHub Copilot CLI currently exposes custom MCP tools to its model but does not make
custom MCP resource reads model-callable. Live link-only probes on CLI `1.0.71` and
`1.0.72-0` issued `tools/list` and `tools/call` but no `resources/list` or
`resources/read`; the same tool result worked when the resource was embedded. GitHub
tracks model-facing support in
[copilot-cli#1803](https://github.com/github/copilot-cli/issues/1803) and
[copilot-cli#1518](https://github.com/github/copilot-cli/issues/1518). The experimental
`session.mcp.resources.*` Copilot SDK RPCs let a host integration read resources; they
are not model tools.

OKH therefore keeps resources canonical and adds two protocol-native compatibility
paths:

- `read_resource` is a read-only model tool over the same provider registry. It returns
  one embedded resource chunk, capped at 48 KiB of source bytes. `contentIndex`,
  `offset`, and `nextOffset` provide deterministic continuation without returning an
  unbounded tool result.
- `help` and `run` embed immediately required resources directly in their tool results,
  capped at 24 KiB per resource and 64 KiB in total. They still return canonical links;
  anything over budget is explicitly marked for `read_resource`. Selection is
  sequential: known sizes are checked before reads, every unknown-size read receives
  only the remaining budget, and no deferred payload is retained.

## Read safety

- Every URI must match a registered fixed resource or template.
- Decoded file paths must be relative, non-empty, and contain no empty, `.` or `..`
  segments.
- Both module root and candidate are resolved through `realpath`. Files are opened
  before metadata is accepted, the opened handle is checked against the current
  path and module boundary, and content is read from that handle. Symlink swaps and
  path replacement therefore cannot redirect an in-progress read outside the module.
- Hidden/control folders and common dependency/cache trees are not listed.
- Valid UTF-8 text is returned in `text`; binary or malformed text is base64 in
  `blob`.
- Reads are bounded while reading the open handle. Content above 16 MiB, including
  a file that grows past the limit during a read, fails explicitly because MCP
  resource reads are not streamed.
- Model-controlled `read_resource` responses are independently chunked to at most
  48 KiB of source bytes, so the native 16 MiB read ceiling cannot become one giant
  model context injection.
- Module indexes visit at most 10,000 directory entries, descend at most 32 levels,
  link at most 1,000 files, probe root overview files independently, omit overview
  bodies above 256 KiB, and cap the final rendered resource at 512 KiB.
- Unknown or escaped files return a generic resource-not-found protocol error rather
  than revealing a host path.

## Tool integration

`help` performs deterministic lexical selection over documentation. Common
instructions require an explicit activation keyword declared in their frontmatter,
so generic help questions do not activate unrelated behavior. Matches are returned
as bounded embedded resources and `resource_link` content. `run` returns:

- readable provider resources declared in skill frontmatter, embedded when bounded;
  and
- sibling files of a local skill, mapped into the target module's file template.

Unsupported or unavailable dependency URIs are rejected instead of being emitted as
unreadable resource links. Oversized declared dependencies remain canonical links and
are identified as deferred; the skill instructions require `read_resource` before
acting. Sibling files are optional on-demand references rather than eager context.

Skill aggregation is also bounded. One skill may declare at most 64 provider
resources. Local sibling discovery visits at most 4,096 entries, descends at most 16
levels, and links at most 128 files. Exceeding a budget rejects `run` explicitly
rather than returning incomplete instructions.

## Adding a provider

1. Implement `ResourceProvider` in `src/resources/`, including
   `read(uri, { maxBytes? })` over the same logic used by protocol registration.
   Honor `maxBytes` before returning a payload.
2. Define a collision-free `okh://` authority or path family.
3. Validate URI variables inside each read callback.
4. Choose fixed resources for small stable sets and templates for parameterized data.
5. Decide deliberately whether template instances belong in `resources/list`.
6. Return accurate MIME types, text/blob encoding, annotations, and sizes where known.
7. Implement `resolveLink(uri)` if skills may depend on the provider, then add it to
   `OkhResourceRegistry.providers`.
8. Add list, read, invalid-URI, and binary tests.
9. Document the new URI family in this file and [reference](okh://docs/reference.md).

If a provider can produce a large flat list, do not assume SDK v1 pagination. Either
keep leaves progressively discoverable or isolate a low-level paginated list handler
behind an adapter for a future SDK migration.

## Research basis

Normative protocol behavior and current SDK details were checked against:

- [MCP resources specification](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [MCP tools and resource links](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP cursor pagination](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/pagination)
- [MCP server concepts](https://modelcontextprotocol.io/docs/learn/server-concepts#resources)
- [`McpServer` v1.29.0 source](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/server/mcp.ts)
- [Official everything-server resource examples](https://github.com/modelcontextprotocol/servers/tree/main/src/everything/resources)
- [GitHub Copilot CLI MCP configuration](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
- [Copilot CLI model-facing resource request](https://github.com/github/copilot-cli/issues/1803)
- [Copilot SDK resource-read RPC types](https://github.com/github/copilot-sdk)

Key compatibility finding: the high-level SDK registers resources and
`listChanged`, but its built-in list handler neither consumes cursors nor emits
`nextCursor`; subscriptions require low-level handlers. Those limitations are kept
behind the provider boundary so a later SDK v2 migration does not spread through the
domain model.
