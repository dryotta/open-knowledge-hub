import {
  ErrorCode,
  McpError,
  type ClientCapabilities,
  type CreateMessageResult,
  type ElicitResult,
  type Implementation,
  type ListRootsResult,
  type RelatedTaskMetadata,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROBE_TIMEOUTS,
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_MIME_TYPE,
  createInitialCapabilityReport,
  runBasicSamplingProbe,
  runRootsProbe,
  type CapabilityProbeClient,
} from "../src/server/capabilityProbes.js";
import { CapabilityRunStore, type CapabilityRunContext } from "../src/server/capabilityRuns.js";

const CONTEXT: CapabilityRunContext = {
  id: "run-123",
  createdAt: "2026-07-11T00:00:00.000Z",
  expiresAt: "2026-07-11T00:30:00.000Z",
};

const RELATED_TASK: RelatedTaskMetadata = { taskId: "task-123" };

function makeClient(overrides: Partial<CapabilityProbeClient> = {}): CapabilityProbeClient {
  return {
    listRoots: async (_params, _options) => ({ roots: [] }),
    createMessage: async () => ({
      model: "test-model",
      role: "assistant",
      content: { type: "text", text: "ack" },
    }),
    elicitInput: async () => ({ action: "decline" }),
    ...overrides,
  };
}

function createRun(
  capabilities: ClientCapabilities,
  clientKey: object = {},
): { store: CapabilityRunStore; clientKey: object; runId: string; signal: AbortSignal } {
  const store = new CapabilityRunStore({
    createId: () => CONTEXT.id,
    now: () => new Date(CONTEXT.createdAt),
  });
  const run = store.createRun(clientKey, (context) => createInitialCapabilityReport(context, capabilities));
  return { store, clientKey, runId: run.id, signal: run.signal };
}

describe("createInitialCapabilityReport", () => {
  it("treats an empty elicitation object as form support", () => {
    const report = createInitialCapabilityReport(CONTEXT, { elicitation: {} });

    expect(report.client.declared.elicitationForm).toBe(true);
    expect(report.client.declared.elicitationUrl).toBe(false);
    expect(report.probes.elicitationForm.status).toBe("pending");
    expect(report.probes.elicitationUrl.status).toBe("unsupported");
  });

  it("retains only normalized booleans and never serializes client or extension payloads", () => {
    const capabilities = {
      roots: { listChanged: true, secret: "root-secret" },
      sampling: { tools: {}, secret: "sampling-secret" },
      elicitation: { form: { applyDefaults: true, token: "form-token" }, url: { secret: "url-secret" } },
      tasks: { token: "task-token" },
      extensions: {
        [MCP_APPS_EXTENSION_ID]: {
          mimeTypes: [MCP_APPS_MIME_TYPE],
          token: "app-token",
          nested: { secret: "nested-secret" },
        },
        "example.private/extension": { password: "extension-password" },
      },
      unknownCapability: { apiKey: "unknown-key" },
    } as unknown as ClientCapabilities;
    const implementation = {
      name: "private-client-name",
      version: "private-client-version",
    } satisfies Implementation;

    const report = createInitialCapabilityReport(CONTEXT, capabilities, implementation);
    const serialized = JSON.stringify(report);

    expect(Object.keys(report.client.declared)).toEqual([
      "roots",
      "rootsListChanged",
      "sampling",
      "samplingTools",
      "elicitationForm",
      "elicitationUrl",
      "tasks",
    ]);
    expect(report.client.declared).toEqual({
      roots: true,
      rootsListChanged: true,
      sampling: true,
      samplingTools: true,
      elicitationForm: true,
      elicitationUrl: true,
      tasks: true,
    });
    for (const privateValue of [
      "root-secret",
      "sampling-secret",
      "form-token",
      "url-secret",
      "task-token",
      "app-token",
      "nested-secret",
      "extension-password",
      "unknown-key",
      "private-client-name",
      "private-client-version",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("initializes app probes only for compatible MCP Apps declarations", () => {
    const compatible = createInitialCapabilityReport(CONTEXT, {
      extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_MIME_TYPE] } },
    });
    const legacyCompatible = createInitialCapabilityReport(CONTEXT, {
      extensions: { [MCP_APPS_EXTENSION_ID]: { privateValue: "not-retained" } },
    });
    const incompatible = createInitialCapabilityReport(CONTEXT, {
      extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: ["text/html"] } },
    });
    const malformed = createInitialCapabilityReport(CONTEXT, {
      extensions: { [MCP_APPS_EXTENSION_ID]: "secret-token" as unknown as object },
    });

    for (const key of ["appInitialize", "appTheme", "appResize"] as const) {
      expect(compatible.probes[key].status).toBe("pending");
      expect(legacyCompatible.probes[key].status).toBe("pending");
      expect(incompatible.probes[key].status).toBe("unsupported");
      expect(malformed.probes[key].status).toBe("unsupported");
    }
    expect(JSON.stringify(malformed)).not.toContain("secret-token");
  });

  it("uses exact production timeouts and initializes unimplemented task probes", () => {
    const report = createInitialCapabilityReport(CONTEXT, {});

    expect(DEFAULT_PROBE_TIMEOUTS).toEqual({
      machineMs: 15_000,
      samplingMs: 5 * 60_000,
      elicitationMs: 10 * 60_000,
    });
    expect(report.schemaVersion).toBe("1");
    expect(report.runId).toBe(CONTEXT.id);
    expect(report.createdAt).toBe(CONTEXT.createdAt);
    expect(report.expiresAt).toBe(CONTEXT.expiresAt);
    for (const key of ["tasksCreate", "tasksPoll", "tasksInput", "tasksResult", "tasksCancel"] as const) {
      expect(report.probes[key].status).toBe("not_exercised");
    }
  });
});

describe("runRootsProbe", () => {
  it("passes valid file roots while retaining only count and name-presence facts", async () => {
    const { store, clientKey, runId } = createRun({ roots: {} });
    const listRoots = vi.fn(async (): Promise<ListRootsResult> => ({
      roots: [
        { uri: "file:///private/secret/path", name: "Private Root Name" },
        { uri: "file:///another/private/path" },
      ],
    }));

    await runRootsProbe(makeClient({ listRoots }), store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);

    const probe = store.getSnapshotForClient(clientKey, runId).report.probes.roots;
    expect(probe).toEqual({
      status: "passed",
      code: "roots.list_passed",
      message: "Roots listed successfully; display names were observed.",
      evidence: { kind: "count", value: 2 },
    });
    const serialized = JSON.stringify(probe);
    expect(serialized).not.toContain("private/secret");
    expect(serialized).not.toContain("another/private");
    expect(serialized).not.toContain("Private Root Name");
  });

  it.each([
    ["non-file", "https://example.com/private"],
    ["malformed", "not a valid URI"],
  ])("fails a %s root URI without retaining it", async (_label, uri) => {
    const { store, clientKey, runId } = createRun({ roots: {} });
    const client = makeClient({ listRoots: async () => ({ roots: [{ uri }] }) });

    await runRootsProbe(client, store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);

    const probe = store.getSnapshotForClient(clientKey, runId).report.probes.roots;
    expect(probe).toEqual({
      status: "failed",
      code: "roots.invalid_uri",
      message: "Roots result included an invalid or non-file URI.",
    });
    expect(JSON.stringify(probe)).not.toContain(uri);
  });

  it("does not report an empty root name as an observed display name", async () => {
    const { store, clientKey, runId } = createRun({ roots: {} });
    const client = makeClient({
      listRoots: async () => ({ roots: [{ uri: "file:///private/root", name: "" }] }),
    });

    await runRootsProbe(client, store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);

    expect(store.getSnapshotForClient(clientKey, runId).report.probes.roots.message).toBe(
      "Roots listed successfully; no display names were observed.",
    );
  });

  it("skips unsupported roots and forwards timeout, signal, and related task when pending", async () => {
    const unsupported = createRun({});
    const unsupportedListRoots = vi.fn(async () => ({ roots: [] }));

    await runRootsProbe(
      makeClient({ listRoots: unsupportedListRoots }),
      unsupported.store,
      unsupported.clientKey,
      unsupported.runId,
      DEFAULT_PROBE_TIMEOUTS,
    );
    expect(unsupportedListRoots).not.toHaveBeenCalled();

    const pending = createRun({ roots: {} });
    const pendingListRoots = vi.fn(async () => ({ roots: [] }));
    await runRootsProbe(
      makeClient({ listRoots: pendingListRoots }),
      pending.store,
      pending.clientKey,
      pending.runId,
      DEFAULT_PROBE_TIMEOUTS,
      RELATED_TASK,
    );

    expect(pendingListRoots).toHaveBeenCalledWith(undefined, {
      timeout: DEFAULT_PROBE_TIMEOUTS.machineMs,
      signal: pending.signal,
      relatedTask: RELATED_TASK,
    });
    expect(pending.store.getSnapshotForClient(pending.clientKey, pending.runId).report.probes.roots).toEqual({
      status: "passed",
      code: "roots.list_passed",
      message: "Roots listed successfully; no display names were observed.",
      evidence: { kind: "count", value: 0 },
    });
  });

  it.each([
    [ErrorCode.RequestTimeout, "roots.timeout", "Roots listing timed out."],
    [ErrorCode.MethodNotFound, "roots.not_implemented", "Roots were advertised but the method is not implemented."],
    [ErrorCode.InvalidParams, "roots.request_failed", "Roots listing failed."],
  ])("classifies roots protocol error %s without copying error payloads", async (errorCode, code, message) => {
    const { store, clientKey, runId } = createRun({ roots: {} });
    const client = makeClient({
      listRoots: async () => {
        throw new McpError(errorCode, "private protocol error", { secret: "error-secret" });
      },
    });

    await runRootsProbe(client, store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);

    const probe = store.getSnapshotForClient(clientKey, runId).report.probes.roots;
    expect(probe).toEqual({ status: "failed", code, message });
    expect(JSON.stringify(probe)).not.toContain("private protocol error");
    expect(JSON.stringify(probe)).not.toContain("error-secret");
  });
});

describe("runBasicSamplingProbe", () => {
  it("passes assistant text responses and discards generated text and model identifiers", async () => {
    const { store, clientKey, runId, signal } = createRun({ sampling: {} });
    const createMessage = vi.fn(async (): Promise<CreateMessageResult> => ({
      model: "private-model-id",
      role: "assistant",
      content: { type: "text", text: "private generated acknowledgement" },
    }));

    await runBasicSamplingProbe(
      makeClient({ createMessage }),
      store,
      clientKey,
      runId,
      DEFAULT_PROBE_TIMEOUTS,
      RELATED_TASK,
    );

    expect(createMessage).toHaveBeenCalledWith(
      {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Reply with one short acknowledgement for an MCP capability test.",
            },
          },
        ],
        includeContext: "none",
        maxTokens: 32,
      },
      {
        timeout: DEFAULT_PROBE_TIMEOUTS.samplingMs,
        signal,
        relatedTask: RELATED_TASK,
      },
    );
    const probe = store.getSnapshotForClient(clientKey, runId).report.probes.samplingBasic;
    expect(probe).toEqual({
      status: "passed",
      code: "sampling.basic_passed",
      message: "Basic sampling returned assistant text.",
    });
    expect(JSON.stringify(probe)).not.toContain("private-model-id");
    expect(JSON.stringify(probe)).not.toContain("private generated acknowledgement");
  });

  it.each([
    {
      label: "wrong role",
      result: { model: "secret-model", role: "user", content: { type: "text", text: "secret text" } },
    },
    {
      label: "no text",
      result: { model: "secret-model", role: "assistant", content: { type: "image", data: "secret-data", mimeType: "image/png" } },
    },
    {
      label: "empty text array",
      result: {
        model: "secret-model",
        role: "assistant",
        content: [{ type: "text", text: "   " }],
      },
    },
  ])("fails an invalid sampling result with $label", async ({ result }) => {
    const { store, clientKey, runId } = createRun({ sampling: {} });
    const client = makeClient({
      createMessage: async () => result as unknown as CreateMessageResult,
    });

    await runBasicSamplingProbe(client, store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);

    const probe = store.getSnapshotForClient(clientKey, runId).report.probes.samplingBasic;
    expect(probe).toEqual({
      status: "failed",
      code: "sampling.invalid_result",
      message: "Basic sampling returned an invalid result.",
    });
    expect(JSON.stringify(probe)).not.toContain("secret");
  });

  it.each(["declined", "rejected", "cancelled", "cancellation", "denied", "not approved"])(
    "records %s sampling as supported but not completed",
    async (reason) => {
      const { store, clientKey, runId } = createRun({ sampling: {} });
      const client = makeClient({
        createMessage: async () => {
          throw new Error(`User ${reason} this request with private details.`);
        },
      });

      await runBasicSamplingProbe(client, store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);

      expect(store.getSnapshotForClient(clientKey, runId).report.probes.samplingBasic).toEqual({
        status: "supported_not_completed",
        code: "sampling.not_completed",
        message: "Basic sampling was supported but not completed by the user.",
      });
    },
  );

  it("fails programmatic AbortError sampling without treating it as a user decline", async () => {
    const { store, clientKey, runId } = createRun({ sampling: {} });
    const client = makeClient({
      createMessage: async () => {
        throw { name: "AbortError", message: "This operation was aborted" };
      },
    });

    await runBasicSamplingProbe(client, store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);

    expect(store.getSnapshotForClient(clientKey, runId).report.probes.samplingBasic).toEqual({
      status: "failed",
      code: "sampling.aborted",
      message: "Basic sampling was aborted.",
    });
  });

  it.each([
    [ErrorCode.RequestTimeout, "sampling.timeout", "Basic sampling timed out."],
    [ErrorCode.MethodNotFound, "sampling.not_implemented", "Sampling was advertised but the method is not implemented."],
    [ErrorCode.InternalError, "sampling.request_failed", "Basic sampling failed."],
  ])("classifies sampling protocol error %s without copying error payloads", async (errorCode, code, message) => {
    const { store, clientKey, runId } = createRun({ sampling: {} });
    const client = makeClient({
      createMessage: async () => {
        throw new McpError(errorCode, "private sampling error", { token: "private-token" });
      },
    });

    await runBasicSamplingProbe(client, store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);

    const probe = store.getSnapshotForClient(clientKey, runId).report.probes.samplingBasic;
    expect(probe).toEqual({ status: "failed", code, message });
    expect(JSON.stringify(probe)).not.toContain("private sampling error");
    expect(JSON.stringify(probe)).not.toContain("private-token");
  });

  it("keeps reports and store snapshots privacy-safe across both probes", async () => {
    const capabilities = {
      roots: {},
      sampling: {},
      extensions: {
        [MCP_APPS_EXTENSION_ID]: {
          mimeTypes: [MCP_APPS_MIME_TYPE],
          token: "private-app-token",
        },
      },
    } as unknown as ClientCapabilities;
    const { store, clientKey, runId } = createRun(capabilities);
    const client = makeClient({
      listRoots: async () => ({
        roots: [{ uri: "file:///private/root", name: "Private Root" }],
      }),
      createMessage: async () => ({
        model: "private-model",
        role: "assistant",
        content: [
          { type: "text", text: "private generated text" },
          { type: "image", data: "private-image", mimeType: "image/png" },
        ],
      }),
    });

    await runRootsProbe(client, store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);
    await runBasicSamplingProbe(client, store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);

    expect(store.getSnapshotForClient(clientKey, runId).report.probes.samplingBasic.status).toBe("passed");
    const serialized = JSON.stringify(store.getSnapshotForClient(clientKey, runId));
    for (const privateValue of [
      "private-app-token",
      "file:///private/root",
      "Private Root",
      "private-model",
      "private generated text",
      "private-image",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });
});
