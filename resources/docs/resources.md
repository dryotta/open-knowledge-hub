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
`src/resources/types.ts`: an `id`, `register(server)`, and optionally
`resolveLink(uri)` when its resources may be declared as skill dependencies. The
composition root is `src/resources/index.ts`; add future providers there without
coupling them to tool registration.

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
- Module indexes visit at most 10,000 directory entries, descend at most 32 levels,
  link at most 1,000 files, probe root overview files independently, omit overview
  bodies above 256 KiB, and cap the final rendered resource at 512 KiB.
- Unknown or escaped files return a generic resource-not-found protocol error rather
  than revealing a host path.

## Tool integration

`help` performs deterministic lexical selection over documentation. Common
instructions require an explicit activation keyword declared in their frontmatter,
so generic help questions do not activate unrelated behavior. Matches are returned
as `resource_link` content. `run` returns:

- readable provider resources declared in skill frontmatter; and
- sibling files of a local skill, mapped into the target module's file template.

Unsupported or unavailable dependency URIs are rejected instead of being emitted as
unreadable resource links. This avoids absolute path strings and lets capable hosts
choose when to load context.

Skill aggregation is also bounded. One skill may declare at most 64 provider
resources. Local sibling discovery visits at most 4,096 entries, descends at most 16
levels, and links at most 128 files. Exceeding a budget rejects `run` explicitly
rather than returning an incomplete discipline.

## Adding a provider

1. Implement `ResourceProvider` in `src/resources/`.
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

Key compatibility finding: the high-level SDK registers resources and
`listChanged`, but its built-in list handler neither consumes cursors nor emits
`nextCursor`; subscriptions require low-level handlers. Those limitations are kept
behind the provider boundary so a later SDK v2 migration does not spread through the
domain model.
