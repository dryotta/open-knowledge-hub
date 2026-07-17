---
title: Read an OKH resource
args:
  uri: Canonical `okh://` resource URI returned by inspect, help, run, or another resource.
  contentIndex: Zero-based content item when a resource returns more than one; defaults to 0.
  offset: Byte offset for the selected content item; defaults to 0. Continue with the prior result's nextOffset.
  maxBytes: Source bytes to return in this chunk (256-49152); defaults to 49152.
---
Read one canonical OKH resource for agents whose MCP host does not expose
`resources/read` as a model-callable operation. Returns a bounded protocol-native
embedded resource plus byte-range metadata. Use `nextOffset` to continue large
resources. This tool accepts only `okh://` URIs; never pass them to filesystem or web
tools.
