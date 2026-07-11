# MCP Client Capabilities Diagnostic Design

**Date:** 2026-07-10
**Status:** Approved design

## Goal

Add one `capabilities` tool that reports advertised MCP client capabilities and
actively probes the client behaviors OKH can exercise on the deployed
`2025-11-25` protocol generation:

- roots
- sampling, including sampling tools
- form and URL elicitation
- MCP Apps rendering and app-to-server communication
- legacy core Tasks, including create, poll, input-required, result, and cancel

Clients without MCP Apps receive the same normalized report as terminal text and
`structuredContent`.

## Scope decisions

- Stay on `@modelcontextprotocol/sdk` v1 and keep Node.js 18 support.
- Test the deployed 2025 protocol behavior end to end.
- Report the modern 2026 per-request/MRTR generation and
  `io.modelcontextprotocol/tasks` extension as `not_exercised`. SDK v1 cannot
  negotiate that era.
- Expose one user-facing tool. Follow-up phases call the same tool with a run ID.
- Retain capability/status metadata only. Never retain root paths, sampling
  content, elicited values, or arbitrary app payloads.
- User decline or cancellation proves that an interactive capability exists; it
  is not a failed protocol test.

## Public MCP surface

### Tool

Add `capabilities` with this logical input:

```ts
type CapabilitiesInput =
  | { action?: "scan" }
  | { action: "app_report"; runId: string; app: AppProbeReport }
  | { action: "task_cancel"; runId: string }
  | { action: "report"; runId: string };

interface AppProbeReport {
  initialized: true;
  theme: "provided" | "absent";
  resize: "observed" | "fixed_container" | "unobserved";
}
```

Use the existing raw-shape registration pattern with optional `action`, `runId`,
and `app` fields. The handler validates the action-specific requirements
explicitly.

`scan` is the default and the only action intended for normal model selection.
The MCP App uses `app_report`; the cancellation workflow and terminal fallback
use `task_cancel` and `report`.

The tool is registered through
`server.experimental.tasks.registerToolTask(...)` with
`execution.taskSupport: "optional"`:

- A normal client call is transparently auto-polled by SDK v1 and receives a
  normal tool result.
- A task-capable client can augment the call and observe task creation, polling,
  input-required state, and result retrieval.

### MCP App resource

Add one packaged resource:

```text
ui://open-knowledge-hub/capabilities
```

It returns a minimal, self-contained HTML5 document with MIME type
`text/html;profile=mcp-app`. The `capabilities` tool metadata links to this URI
through both:

```json
{
  "ui": {
    "resourceUri": "ui://open-knowledge-hub/capabilities"
  },
  "ui/resourceUri": "ui://open-knowledge-hub/capabilities"
}
```

The flat key is retained for older host compatibility. The server advertises the
`io.modelcontextprotocol/ui` extension and the supported MCP App MIME type.

The resource requests no external domains, browser permissions, or dedicated
origin.

## Normalized report

The tool returns a compact text table and equivalent `structuredContent`:

```ts
type ProbeStatus =
  | "passed"
  | "supported_not_completed"
  | "advertised_only"
  | "unsupported"
  | "failed"
  | "pending"
  | "not_exercised";

interface CapabilityProbeResult {
  status: ProbeStatus;
  advertised?: boolean;
  durationMs?: number;
  detail?: string;
  errorCode?: string;
}

interface CapabilityReport {
  runId: string;
  overall: "pending" | "complete" | "partial";
  client: {
    name?: string;
    version?: string;
    protocolVersion?: string;
  };
  advertised: {
    capabilityKeys: string[];
    extensionIds: string[];
    roots?: { listChanged?: boolean };
    sampling?: { context?: boolean; tools?: boolean };
    elicitation?: { form?: boolean; url?: boolean };
    tasks?: Record<string, unknown>;
  };
  probes: {
    roots: CapabilityProbeResult;
    rootsListChanged: CapabilityProbeResult;
    samplingBasic: CapabilityProbeResult;
    samplingTools: CapabilityProbeResult;
    elicitationForm: CapabilityProbeResult;
    elicitationUrl: CapabilityProbeResult;
    mcpAppsRender: CapabilityProbeResult;
    mcpAppsTheme: CapabilityProbeResult;
    mcpAppsResize: CapabilityProbeResult;
    mcpAppsServerCall: CapabilityProbeResult;
    legacyTaskCreate: CapabilityProbeResult;
    legacyTaskPoll: CapabilityProbeResult;
    legacyTaskInputRequired: CapabilityProbeResult;
    legacyTaskResult: CapabilityProbeResult;
    legacyTaskCancel: CapabilityProbeResult;
    modernProtocol: CapabilityProbeResult;
    tasksExtension: CapabilityProbeResult;
  };
  nextActions: string[];
}
```

`detail` uses fixed diagnostic phrases, not returned payload content. Unknown
capability and extension names may be listed; arbitrary nested values are not
copied into the report.

Overall status is deterministic:

- `pending` when any probe is pending
- `partial` when no probe is pending and at least one probe failed
- `complete` otherwise

## Architecture

Use these focused modules:

- `src/server/capabilities.ts` — registration, action dispatch, task lifecycle,
  and MCP App resource registration
- `src/server/capabilityProbes.ts` — sequential probe runner
- `src/server/capabilityRuns.ts` — bounded redacted run store
- `src/server/capabilityReport.ts` — normalized status calculation and text
  formatting
- `src/server/capabilityTaskStore.ts` — task-store wrapper that records whether
  the originating call was task-augmented; observes polling, result retrieval,
  and cancellation; and regenerates the current diagnostic report when a task
  result is retrieved

Avoid moving unrelated tools or rewriting the general server architecture.

`buildServer` creates or accepts injectable instances of:

- a task store
- a task message queue
- a capability-run store
- a clock/ID source where deterministic tests need them

Production uses bounded in-memory implementations. Tests inject deterministic
fakes.

## Run lifecycle

### Scan

1. Create a cryptographically random run ID.
2. Snapshot the negotiated protocol version, client implementation, advertised
   client capabilities, and extension IDs.
3. Initialize all probe statuses.
4. Create the SDK task and start the asynchronous probe runner.
5. Store the provisional server-side scan result in the task store when roots,
   sampling, and elicitation probes finish. MCP App and cancellation follow-ups
   may still be pending.
6. Return the task handle immediately to task-augmented clients; normal calls
   are auto-polled by SDK v1.

For a diagnostic task, the task-store wrapper handles result retrieval by first
recording that retrieval, then returning a freshly formatted report. This lets
the result being retrieved truthfully report `legacyTaskResult: passed` instead
of returning a stale pre-retrieval snapshot. Store observations count only when
the originating tool request was task-augmented; SDK internal auto-polling for a
normal call does not count as client task support.

Initialize conditional follow-up statuses as follows:

- compatible advertised MCP Apps support starts the four app probes as
  `pending`; absent or MIME-incompatible support is `unsupported`
- a task-augmented scan starts create, poll, input-required, and result tracking;
  a normal scan marks them `not_exercised`
- task cancellation is initially `not_exercised` and becomes `pending` only
  after a task-augmented `task_cancel` call is accepted
- when no sampling or elicitation probe can run, task input-required is
  `not_exercised`

If a task result is retrieved without a preceding status poll, mark task polling
`supported_not_completed`. If the run expires before task polling or result
retrieval is observed, mark the corresponding probe
`supported_not_completed`.

Run records expire after 30 minutes. The store holds at most 32 runs, evicts
expired records first, then evicts the oldest remaining record when capacity is
reached. Nothing is persisted under `OKH_HOME`.

Where client identity is available, bind the run to a stable fingerprint of the
client name/version plus SDK session ID when present. Reject cross-client
follow-up calls when a binding is available; otherwise rely on the unguessable
run ID and process-local lifetime.

### App callback

After the normal scan result renders:

1. The HTML app performs `ui/initialize`.
2. It records whether host context and theme were provided.
3. It changes its document size, sends the standard size-change notification,
   and observes whether the viewport/container dimensions change or the host
   declared a fixed container.
4. It calls the same `capabilities` tool with `action: "app_report"` and the run
   ID.
5. The server validates the fixed enum/boolean schema, marks the same-server tool
   call as passed because the callback arrived, and updates the run.
6. The app renders the refreshed normalized report.

The callback proves app-to-server tool calling. The server does not accept
arbitrary strings, HTML, URLs, or nested metadata from the app.

### Task cancellation

The initial report tells task-capable clients to invoke:

```json
{ "action": "task_cancel", "runId": "<run-id>" }
```

as a task-augmented call with a finite TTL.

- If the call is not task-augmented, complete immediately and record
  `not_exercised`.
- If it is task-augmented, create a disposable task that remains `working` until
  the client sends `tasks/cancel`.
- A task-store wrapper records whether the originating request included task
  augmentation and observes transition to `cancelled`.
- The run records cancellation as passed. The cancelled invocation itself cannot
  return an aggregate result.
- If the five-minute TTL expires before cancellation, record
  `supported_not_completed`.
- The MCP App polls the same tool with `action: "report"`. Terminal clients can
  make that report call explicitly.

## Probe behavior

Run probes sequentially to avoid overlapping consent interfaces. A probe failure
does not abort independent later probes unless the transport or connection is no
longer usable.

### Consent probes require task augmentation

Sampling and elicitation probes surface a consent interface and can block for
minutes waiting on a human. They are exercised live only on a **task-augmented**
scan, where each is wrapped in an `input_required` → `working` transition. On a
**normal** scan these advertised-but-unexercised probes return immediately as
`advertised_only`; the diagnostic never sends a consent-gated request outside a
task so a non-interactive client (for example a CLI running unattended) cannot
hang. Roots is a machine probe requiring no consent and always runs on both scan
kinds.

### Roots

If `roots` is absent, report `unsupported`.

Otherwise call `roots/list` and validate:

- the response has a roots array
- each URI parses
- each URI uses the currently allowed `file:` scheme

Roots runs while the task is `working`, so it is sent as a direct request without
`relatedTask` metadata. Requests carrying `relatedTask` are queued by the SDK for
delivery only when the client pulls task messages (on `input_required` or
`tasks/result`); tagging the machine roots probe would make it hang until timeout
during a task-augmented scan.

Retain only:

- root count
- distinct URI schemes
- whether any root includes a display name

Never retain or display a root URI or path.

`roots.listChanged` is `advertised_only` when the flag is true and `unsupported`
otherwise. The diagnostic must not ask users to change workspaces or mutate
client configuration to force a notification.

### Basic sampling

If `sampling` is absent, report `unsupported`.

Send a small text-only request with no context inclusion, a low token limit, and
no model-specific requirement. Pass when the client returns a structurally valid
assistant result containing non-empty text. Record model presence as a boolean,
not the model name, and discard all generated content.

User rejection or cancellation is `supported_not_completed`. Protocol errors,
invalid result shapes, and timeouts are `failed`.

### Sampling with tools

Only run when `sampling.tools` is advertised; otherwise report `unsupported`.

1. Send a request-scoped synthetic `capability_echo` tool with
   `toolChoice: { mode: "required" }`.
2. Validate returned `tool_use` blocks, unique IDs, tool name, and object input.
3. Produce matching `tool_result` blocks locally.
4. Send a follow-up sampling request.
5. Validate a structurally valid final assistant response.

The synthetic sampling tool is not added to the server's public tool list.
Generated text and tool input values are discarded.

### Form elicitation

Run when form elicitation is advertised, including the backwards-compatible
empty elicitation capability.

Request one boolean field:

```text
Confirm this MCP client capability test.
```

An accepted, schema-valid boolean passes. Decline or cancel is
`supported_not_completed`. Do not retain the returned value.

### URL elicitation

Run only when URL mode is advertised. Use a unique URL under the reserved,
non-resolving domain:

```text
https://example.invalid/open-knowledge-hub/capabilities/<run-id>
```

Use the run ID to derive a unique `elicitationId` as required by the 2025
protocol.

The test measures whether the client presents and resolves the URL-consent
interaction; it does not require navigation success or an elicitation-complete
notification. Accept is `passed`; decline and cancel are
`supported_not_completed`.

### MCP Apps

Advertised support requires the `io.modelcontextprotocol/ui` extension and a
compatible MIME type when the client provides a MIME-type list. A present
extension with an incompatible MIME-type list is `unsupported`, with a fixed
detail explaining the mismatch.

The live probe is completed only by the HTML app callback:

- app initialized
- theme is `passed` when supplied and `unsupported` when absent
- resize is `passed` when a container/viewport change is observed,
  `supported_not_completed` for a declared fixed container, and `failed` when
  no outcome is observable
- same-server tool call succeeded

Absence of the extension is `unsupported`. An advertised extension with no
callback remains `pending` until run expiry, then becomes `failed` with a fixed
"advertised but app did not initialize" reason.

The normal text result always remains meaningful; MCP Apps is an enhancement,
not a requirement for using the diagnostic.

### Legacy core Tasks

The `capabilities` tool itself is the task probe.

When the client task-augments the scan:

- task creation is `passed` when the augmented request is accepted
- task polling is `passed` after at least one client task-status request
- result retrieval is `passed` when the client requests the completed result;
  that response contains the freshly formatted normal capability report
- before each sampling or elicitation request, the task status changes to
  `input_required`
- after the response, status returns to `working`

Nested server-to-client requests carry related-task metadata and use the
in-memory task message queue so they remain associated with the diagnostic task.

The cancellation phase exercises `tasks/cancel` separately as described above.

The legacy `ClientCapabilities.tasks` object describes tasks hosted by the
client for sampling/elicitation; it does not prove that the host consumes
server-hosted tool tasks. Report those flags separately. If the scan is invoked
normally, mark the live server-task lifecycle `not_exercised`. Only an observed
task-augmented call can pass it.

### Modern protocol and Tasks extension

SDK v1 only negotiates the 2025-era initialization flow. Therefore:

- modern per-request client capabilities and MRTR are `not_exercised`
- `io.modelcontextprotocol/tasks` is listed if advertised but is
  `not_exercised`
- the report explains that a future SDK v2 migration is required for a live
  modern-era probe

Do not infer modern support solely from unknown metadata or client branding.

## Failure handling and timeouts

Use these injectable production defaults:

- roots and machine-only operations: 15 seconds
- each sampling request: 5 minutes
- each elicitation request: 10 minutes
- cancellation task TTL: 5 minutes
- task polling hint: 500 milliseconds

Tests use shorter injected values.

Classify outcomes consistently:

| Condition | Status |
| --- | --- |
| Capability absent | `unsupported` |
| Flag exists but no safe live trigger exists | `advertised_only` |
| Protocol exchange succeeds | `passed` |
| Protocol path works but consent or host constraints prevent full confirmation | `supported_not_completed` |
| Advertised capability returns method-not-found, malformed data, or timeout | `failed` |
| Waiting for app callback or cancellation phase | `pending` |
| Outside the SDK/protocol generation under test | `not_exercised` |

Do not silently downgrade errors into success-shaped results. The aggregate tool
call succeeds when it can return a report; individual failed probes remain
visible in that report. Invalid action arguments, unknown runs, expired runs,
and cross-client follow-ups return normal MCP tool errors.

## Privacy and security

- No raw root URI or filesystem path enters retained state or report output.
- No generated model content is retained.
- No elicited content is retained.
- App callbacks accept a fixed schema only.
- The app has no external network CSP allowances or browser permissions.
- Run IDs are random, expire, and are client-bound where possible.
- The URL elicitation uses a reserved non-resolving domain.
- The diagnostic makes no repository, registry, preferences, or container
  changes.
- Request cancellation and timeouts must stop probe work and prevent late
  results from overwriting terminal states.

## Repository changes

Integration points:

- add the `capabilities` tool schema and metadata resource
- add capability orchestration, run-store, probe, report, and app-resource
  modules under `src/server`
- construct the MCP server with injectable task store/message queue dependencies
- add the packaged HTML resource under `resources/apps/`
- update the exact tool count from 9 to 10
- document the one MCP App resource and command-line fallback
- update README and development/manual testing guidance
- add an eval scenario for the CLI fallback

The HTML stays minimal and self-contained. It is protocol test infrastructure,
not a general OKH frontend.

## Testing

### Unit tests

Cover:

- capability normalization, including empty elicitation compatibility
- status transitions and overall report calculation
- fixed-detail/error classification
- privacy redaction
- run expiry, capacity, client binding, and invalid actions
- app callback schema validation
- report text and structured-content equivalence

### In-memory MCP integration tests

Use SDK clients with controlled capabilities and request handlers to cover:

- no optional client capabilities
- roots success and malformed roots
- basic sampling success/rejection/error
- sampling tool loop success and invalid tool-use/result IDs
- form elicitation accept/decline/cancel
- URL elicitation accept/decline/cancel
- task-augmented scan create/poll/input-required/result
- non-task auto-poll fallback
- task cancellation and subsequent report retrieval
- MCP App tool metadata, extension advertisement, resource listing/read, MIME
  type, and app callback
- modern/tasks-extension `not_exercised` reporting

Tests must assert that sensitive probe payloads do not appear in text,
`structuredContent`, or retained run state.

### Eval and manual validation

Add a Copilot CLI eval scenario that calls `capabilities` and validates:

- the tool is called
- a terminal-friendly normalized report is returned
- unsupported or unexercised capabilities are reported explicitly
- no MCP App UI is assumed

Because this is a larger MCP-surface change, completion requires:

```text
npm run build
npm run typecheck
npm test
npm run typecheck:eval
npm run test:eval
npm run eval:validate
npm run eval
```

Build before the live eval because the harness launches `dist/index.js`.

Manual validation uses:

- at least one MCP Apps-capable GUI host, checking render, theme/context,
  resize, app-to-server callback, and refreshed report
- at least one terminal client, checking the text fallback and same-tool
  cancellation/report workflow

## Non-goals

- Migrating OKH to SDK v2
- Implementing the modern Tasks extension
- Persisting diagnostic history
- Proving `roots/list_changed` through user workspace mutation
- Testing model quality or retaining model output
- Adding a reusable web application framework
- Changing existing OKH container/module behavior
