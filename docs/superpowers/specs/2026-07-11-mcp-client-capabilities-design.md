# MCP Client Capabilities Tool Design

## Goal

Add a zero-argument `capabilities` tool that reports whether the connected MCP client advertises roots, sampling, elicitation, and MCP Apps support. Each advertised core capability is tested on every call. No eval scenarios are required.

## Tool API

The tool follows the existing `toolShapes`, tool metadata, and `registerTool` patterns.

```json
{}
```

It returns a compact text summary and structured content:

```json
{
  "features": {
    "roots": { "available": true, "status": "passed", "message": "Roots request succeeded." },
    "sampling": { "available": true, "status": "passed", "message": "Sampling request succeeded." },
    "elicitation": { "available": true, "status": "declined", "message": "Elicitation was declined." },
    "apps": { "available": true, "status": "advertised", "message": "MCP Apps extension is advertised." }
  }
}
```

Statuses are:

- `unsupported`: the client did not advertise the feature; no request is sent.
- `passed`: the advertised core feature returned a protocol-valid response.
- `declined`: the elicitation request was declined or cancelled.
- `failed`: an advertised core feature errored or timed out.
- `advertised`: the MCP Apps extension was negotiated, but rendering cannot be verified from the server.

## Probe Flow

The handler reads `server.server.getClientCapabilities()` and probes features sequentially:

1. **Roots:** call `server.server.listRoots()`. A protocol-valid response passes. Do not return root URIs, names, or counts.
2. **Sampling:** call `server.server.createMessage()` with a short diagnostic prompt. Any protocol-valid response passes. Discard generated content and model metadata.
3. **Elicitation:** call `server.server.elicitInput()` with a minimal boolean confirmation form. An accepted, schema-valid response passes; decline or cancel returns `declined`. Discard submitted values.
4. **MCP Apps:** inspect `clientCapabilities.extensions["io.modelcontextprotocol/ui"]`. Negotiation is the only reliable server-side check because the host provides no render acknowledgement.

Each request uses a bounded timeout. An expected protocol error or timeout becomes a sanitized `failed` result for that feature, and later probes still run. Unexpected errors outside an individual probe continue through the existing tool error handling.

## Privacy and Safety

The result uses fixed messages only. It must not echo roots, sampled text, model identifiers, elicited content, extension configuration, or raw client errors. Sampling and elicitation run only when the client advertised support, but they run automatically whenever the tool is called.

## Code Structure

- Add `capabilities` to `src/server/toolSchemas.ts`.
- Add `resources/tool-meta/capabilities.md`.
- Add a focused capability probe module under `src/server/`.
- Register the tool from `registerTools`, passing the `McpServer` instance to the probe handler.
- Keep formatting and probe result types within the capability module so `tools.ts` remains focused on registration.

## Testing

Use in-memory MCP clients and focused Vitest tests covering:

- all four features advertised;
- partial or absent capabilities;
- successful roots and sampling requests;
- accepted, declined, and cancelled elicitation;
- request errors and timeouts without stopping later probes;
- MCP Apps extension detection;
- output that never includes observed root, sampling, elicitation, extension, or raw error values;
- tool schema/metadata parity and tool listing.

Do not add eval tests or a new MCP App UI.
