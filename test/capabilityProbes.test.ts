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
  runCapabilityProbes,
  runFormElicitationProbe,
  runRootsProbe,
  runSamplingToolsProbe,
  runUrlElicitationProbe,
  type CapabilityProbeClient,
  type CapabilityTaskProbeContext,
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
});

describe("runSamplingToolsProbe", () => {
    it("completes one synthetic tool loop with exact requests and privacy-safe evidence", async () => {
      const { store, clientKey, runId, signal } = createRun({ sampling: { tools: {} } });
      const firstContent = [
        { type: "text", text: "private model preamble" },
        {
          type: "tool_use",
          id: "private-tool-use-id",
          name: "capability_echo",
          input: { value: "private tool input" },
        },
      ];
      const createMessage = vi
        .fn()
        .mockResolvedValueOnce({
          model: "private-first-model",
          role: "assistant",
          content: firstContent,
        })
        .mockResolvedValueOnce({
          model: "private-final-model",
          role: "assistant",
          content: { type: "text", text: "private final summary" },
        });

      await runSamplingToolsProbe(
        makeClient({ createMessage }),
        store,
        clientKey,
        runId,
        DEFAULT_PROBE_TIMEOUTS,
        RELATED_TASK,
      );

      const tool = {
        name: "capability_echo",
        description: "Echo one object to verify sampling tool use.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      };
      const originalUserMessage = {
        role: "user",
        content: {
          type: "text",
          text: "Call capability_echo exactly once with an object containing value, then summarize success.",
        },
      };
      const options = {
        timeout: DEFAULT_PROBE_TIMEOUTS.samplingMs,
        signal,
        relatedTask: RELATED_TASK,
      };
      expect(createMessage).toHaveBeenNthCalledWith(
        1,
        {
          messages: [originalUserMessage],
          includeContext: "none",
          maxTokens: 64,
          tools: [tool],
          toolChoice: { mode: "required" },
        },
        options,
      );
      expect(createMessage).toHaveBeenNthCalledWith(
        2,
        {
          messages: [
            originalUserMessage,
            { role: "assistant", content: firstContent },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  toolUseId: "private-tool-use-id",
                  content: [{ type: "text", text: "capability_echo completed" }],
                },
              ],
            },
          ],
          includeContext: "none",
          maxTokens: 64,
          tools: [tool],
          toolChoice: { mode: "none" },
        },
        options,
      );

      const result = store.getSnapshotForClient(clientKey, runId).report.probes.samplingTools;
      expect(result).toEqual({
        status: "passed",
        code: "sampling.tools_passed",
        message: "Sampling completed one synthetic tool call.",
        evidence: { kind: "count", value: 1 },
      });
      const serialized = JSON.stringify(result);
      for (const privateValue of [
        "private tool input",
        "private model preamble",
        "private final summary",
        "private-first-model",
        "private-final-model",
        "private-tool-use-id",
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
    });

    it.each([
      {
        label: "missing tool use",
        content: { type: "text", text: "private missing output" },
        code: "sampling.tools_missing_tool_use",
        message: "Sampling did not return a tool use.",
      },
      {
        label: "unknown tool",
        content: { type: "tool_use", id: "id-1", name: "private_unknown", input: { value: "secret" } },
        code: "sampling.tools_unknown_tool",
        message: "Sampling returned an unknown tool name.",
      },
      {
        label: "multiple tool uses",
        content: [
          { type: "tool_use", id: "id-1", name: "capability_echo", input: { value: "secret-1" } },
          { type: "tool_use", id: "id-2", name: "capability_echo", input: { value: "secret-2" } },
        ],
        code: "sampling.tools_multiple_tool_uses",
        message: "Sampling returned more than one tool use.",
      },
      {
        label: "duplicate tool-use IDs",
        content: [
          { type: "tool_use", id: "duplicate-private-id", name: "capability_echo", input: { value: "secret-1" } },
          { type: "tool_use", id: "duplicate-private-id", name: "capability_echo", input: { value: "secret-2" } },
        ],
        code: "sampling.tools_duplicate_id",
        message: "Sampling returned duplicate tool-use IDs.",
      },
      {
        label: "invalid input",
        content: {
          type: "tool_use",
          id: "id-1",
          name: "capability_echo",
          input: { value: 42, extra: "private-extra" },
        },
        code: "sampling.tools_invalid_input",
        message: "Sampling returned invalid tool input.",
      },
      {
        label: "empty ID",
        content: { type: "tool_use", id: "", name: "capability_echo", input: { value: "secret" } },
        code: "sampling.tools_invalid_id",
        message: "Sampling returned an invalid tool-use ID.",
      },
    ])("fails $label without a second request or payload leakage", async ({ content, code, message }) => {
      const { store, clientKey, runId } = createRun({ sampling: { tools: {} } });
      const createMessage = vi.fn(async () => ({
        model: "private-model",
        role: "assistant",
        content,
      }));

      await runSamplingToolsProbe(
        makeClient({ createMessage }),
        store,
        clientKey,
        runId,
        DEFAULT_PROBE_TIMEOUTS,
      );

      expect(createMessage).toHaveBeenCalledTimes(1);
      const result = store.getSnapshotForClient(clientKey, runId).report.probes.samplingTools;
      expect(result).toEqual({ status: "failed", code, message });
      expect(JSON.stringify(result)).not.toMatch(/private|secret|duplicate-private-id/);
    });

    it("fails when the final assistant response has no non-empty text", async () => {
      const { store, clientKey, runId } = createRun({ sampling: { tools: {} } });
      const createMessage = vi
        .fn()
        .mockResolvedValueOnce({
          model: "model",
          role: "assistant",
          content: { type: "tool_use", id: "tool-id", name: "capability_echo", input: { value: "secret" } },
        })
        .mockResolvedValueOnce({
          model: "private-final-model",
          role: "assistant",
          content: { type: "text", text: "   " },
        });

      await runSamplingToolsProbe(
        makeClient({ createMessage }),
        store,
        clientKey,
        runId,
        DEFAULT_PROBE_TIMEOUTS,
      );

      expect(store.getSnapshotForClient(clientKey, runId).report.probes.samplingTools).toEqual({
        status: "failed",
        code: "sampling.tools_invalid_final",
        message: "Sampling returned an invalid final response.",
      });
    });

    it.each(["declined", "cancelled"])("maps user %s to supported_not_completed", async (reason) => {
      const { store, clientKey, runId } = createRun({ sampling: { tools: {} } });
      const client = makeClient({
        createMessage: async () => {
          throw new Error(`User ${reason} private request details.`);
        },
      });

      await runSamplingToolsProbe(client, store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);

      expect(store.getSnapshotForClient(clientKey, runId).report.probes.samplingTools).toEqual({
        status: "supported_not_completed",
        code: "sampling.tools_not_completed",
        message: "Sampling with tools was supported but not completed by the user.",
      });
    });

    it("classifies AbortError as failed and skips a non-pending probe", async () => {
      const pending = createRun({ sampling: { tools: {} } });
      await runSamplingToolsProbe(
        makeClient({
          createMessage: async () => {
            throw { name: "AbortError", message: "private aborted payload" };
          },
        }),
        pending.store,
        pending.clientKey,
        pending.runId,
        DEFAULT_PROBE_TIMEOUTS,
      );
      expect(pending.store.getSnapshotForClient(pending.clientKey, pending.runId).report.probes.samplingTools).toEqual({
        status: "failed",
        code: "sampling.tools_aborted",
        message: "Sampling with tools was aborted.",
      });

      const unsupported = createRun({ sampling: {} });
      const createMessage = vi.fn();
      await runSamplingToolsProbe(
        makeClient({ createMessage }),
        unsupported.store,
        unsupported.clientKey,
        unsupported.runId,
        DEFAULT_PROBE_TIMEOUTS,
      );
      expect(createMessage).not.toHaveBeenCalled();
    });

    it.each([
      [ErrorCode.RequestTimeout, "sampling.tools_timeout", "Sampling with tools timed out."],
      [
        ErrorCode.MethodNotFound,
        "sampling.tools_not_implemented",
        "Sampling with tools was advertised but is not implemented.",
      ],
      [ErrorCode.InternalError, "sampling.tools_request_failed", "Sampling with tools failed."],
    ])("classifies sampling-tools protocol error %s without payload leakage", async (errorCode, code, message) => {
      const { store, clientKey, runId } = createRun({ sampling: { tools: {} } });
      await runSamplingToolsProbe(
        makeClient({
          createMessage: async () => {
            throw new McpError(errorCode, "private tools error", { secret: "private-token" });
          },
        }),
        store,
        clientKey,
        runId,
        DEFAULT_PROBE_TIMEOUTS,
      );

      const result = store.getSnapshotForClient(clientKey, runId).report.probes.samplingTools;
      expect(result).toEqual({ status: "failed", code, message });
      expect(JSON.stringify(result)).not.toContain("private");
    });

    it("does not treat a generic cancellation error as a user decline", async () => {
      const { store, clientKey, runId } = createRun({ sampling: { tools: {} } });
      await runSamplingToolsProbe(
        makeClient({
          createMessage: async () => {
            throw new Error("private request cancelled by transport");
          },
        }),
        store,
        clientKey,
        runId,
        DEFAULT_PROBE_TIMEOUTS,
      );

      expect(store.getSnapshotForClient(clientKey, runId).report.probes.samplingTools).toEqual({
        status: "failed",
        code: "sampling.tools_request_failed",
        message: "Sampling with tools failed.",
      });
    });
  });

  describe("elicitation probes", () => {
    it("passes valid form acceptance with exact request options and discards the value", async () => {
      const { store, clientKey, runId, signal } = createRun({ elicitation: {} });
      const elicitInput = vi.fn(async (): Promise<ElicitResult> => ({
        action: "accept",
        content: { confirmed: true },
      }));

      await runFormElicitationProbe(
        makeClient({ elicitInput }),
        store,
        clientKey,
        runId,
        DEFAULT_PROBE_TIMEOUTS,
        RELATED_TASK,
      );

      expect(elicitInput).toHaveBeenCalledWith(
        {
          mode: "form",
          message: "Confirm this MCP client capability test.",
          requestedSchema: {
            type: "object",
            properties: {
              confirmed: { type: "boolean", title: "Confirm capability test" },
            },
            required: ["confirmed"],
          },
        },
        {
          timeout: DEFAULT_PROBE_TIMEOUTS.elicitationMs,
          signal,
          relatedTask: RELATED_TASK,
        },
      );
      const result = store.getSnapshotForClient(clientKey, runId).report.probes.elicitationForm;
      expect(result).toEqual({
        status: "passed",
        code: "elicitation.form_passed",
        message: "Form elicitation returned valid confirmation.",
      });
      expect(JSON.stringify(result)).not.toContain("confirmed");
      expect(JSON.stringify(result)).not.toContain("true");
    });

    it.each([
      undefined,
      {},
      { confirmed: "private-not-boolean" },
      { other: true, secret: "private-content" },
    ])("fails accepted form content that is missing or invalid", async (content) => {
      const { store, clientKey, runId } = createRun({ elicitation: {} });
      const client = makeClient({
        elicitInput: async () => ({ action: "accept", content }) as unknown as ElicitResult,
      });

      await runFormElicitationProbe(client, store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);

      const result = store.getSnapshotForClient(clientKey, runId).report.probes.elicitationForm;
      expect(result).toEqual({
        status: "failed",
        code: "elicitation.form_invalid_content",
        message: "Form elicitation accepted without valid confirmation.",
      });
      expect(JSON.stringify(result)).not.toContain("private");
    });

    it.each(["decline", "cancel"] as const)("maps form %s to supported_not_completed", async (action) => {
      const { store, clientKey, runId } = createRun({ elicitation: {} });

      await runFormElicitationProbe(
        makeClient({ elicitInput: async () => ({ action }) }),
        store,
        clientKey,
        runId,
        DEFAULT_PROBE_TIMEOUTS,
      );

      expect(store.getSnapshotForClient(clientKey, runId).report.probes.elicitationForm).toEqual({
        status: "supported_not_completed",
        code: "elicitation.form_not_completed",
        message: "Form elicitation was supported but not completed by the user.",
      });
    });

    it("fails malformed form results and AbortError without leaking payloads", async () => {
      const malformed = createRun({ elicitation: {} });
      await runFormElicitationProbe(
        makeClient({
          elicitInput: async () =>
            ({ action: "private-malformed-action", content: { secret: "private-content" } }) as unknown as ElicitResult,
        }),
        malformed.store,
        malformed.clientKey,
        malformed.runId,
        DEFAULT_PROBE_TIMEOUTS,
      );
      const malformedResult = malformed.store.getSnapshotForClient(
        malformed.clientKey,
        malformed.runId,
      ).report.probes.elicitationForm;
      expect(malformedResult).toEqual({
        status: "failed",
        code: "elicitation.form_invalid_result",
        message: "Form elicitation returned an invalid result.",
      });
      expect(JSON.stringify(malformedResult)).not.toContain("private");

      const malformedContent = createRun({ elicitation: {} });
      await runFormElicitationProbe(
        makeClient({
          elicitInput: async () =>
            ({
              action: "accept",
              content: { confirmed: { secret: "private-content" } },
            }) as unknown as ElicitResult,
        }),
        malformedContent.store,
        malformedContent.clientKey,
        malformedContent.runId,
        DEFAULT_PROBE_TIMEOUTS,
      );
      const malformedContentResult = malformedContent.store.getSnapshotForClient(
        malformedContent.clientKey,
        malformedContent.runId,
      ).report.probes.elicitationForm;
      expect(malformedContentResult).toEqual({
        status: "failed",
        code: "elicitation.form_invalid_result",
        message: "Form elicitation returned an invalid result.",
      });
      expect(JSON.stringify(malformedContentResult)).not.toContain("private");

      const aborted = createRun({ elicitation: {} });
      await runFormElicitationProbe(
        makeClient({
          elicitInput: async () => {
            throw { name: "AbortError", message: "private abort payload" };
          },
        }),
        aborted.store,
        aborted.clientKey,
        aborted.runId,
        DEFAULT_PROBE_TIMEOUTS,
      );
      expect(aborted.store.getSnapshotForClient(aborted.clientKey, aborted.runId).report.probes.elicitationForm).toEqual({
        status: "failed",
        code: "elicitation.form_aborted",
        message: "Form elicitation was aborted.",
      });
    });

    it("uses the reserved URL, encoded run ID, exact options, and passes acceptance", async () => {
      const runIdValue = "run / private?value";
      const store = new CapabilityRunStore({
        createId: () => runIdValue,
        now: () => new Date(CONTEXT.createdAt),
      });
      const clientKey = {};
      const run = store.createRun(clientKey, (context) =>
        createInitialCapabilityReport(context, { elicitation: { url: {} } }),
      );
      const elicitInput = vi.fn(async (): Promise<ElicitResult> => ({
        action: "accept",
        content: { private: "must-not-be-retained" },
      }));

      await runUrlElicitationProbe(
        makeClient({ elicitInput }),
        store,
        clientKey,
        run.id,
        DEFAULT_PROBE_TIMEOUTS,
        RELATED_TASK,
      );

      expect(elicitInput).toHaveBeenCalledWith(
        {
          mode: "url",
          message: "Open this reserved URL to confirm URL elicitation support.",
          elicitationId: `capabilities-${runIdValue}`,
          url: `https://example.invalid/open-knowledge-hub/capabilities/${encodeURIComponent(runIdValue)}`,
        },
        {
          timeout: DEFAULT_PROBE_TIMEOUTS.elicitationMs,
          signal: run.signal,
          relatedTask: RELATED_TASK,
        },
      );
      const result = store.getSnapshotForClient(clientKey, run.id).report.probes.elicitationUrl;
      expect(result).toEqual({
        status: "passed",
        code: "elicitation.url_passed",
        message: "URL elicitation was accepted.",
      });
      expect(JSON.stringify(result)).not.toContain("must-not-be-retained");
    });

    it.each(["decline", "cancel"] as const)("maps URL %s to supported_not_completed", async (action) => {
      const { store, clientKey, runId } = createRun({ elicitation: { url: {} } });

      await runUrlElicitationProbe(
        makeClient({ elicitInput: async () => ({ action }) }),
        store,
        clientKey,
        runId,
        DEFAULT_PROBE_TIMEOUTS,
      );

      expect(store.getSnapshotForClient(clientKey, runId).report.probes.elicitationUrl).toEqual({
        status: "supported_not_completed",
        code: "elicitation.url_not_completed",
        message: "URL elicitation was supported but not completed by the user.",
      });
    });

    it.each([
      {
        label: "missing action",
        result: { content: { url: "https://private.invalid/secret" } },
        privateValue: "private",
      },
      {
        label: "malformed action",
        result: { action: "private-action", content: { url: "https://private.invalid/secret" } },
        privateValue: "private",
      },
      {
        label: "malformed accepted content",
        result: { action: "accept", content: { path: { secret: "private-content" } } },
        privateValue: "private",
      },
      {
        label: "malformed declined content",
        result: { action: "decline", content: { path: { secret: "private-content" } } },
        privateValue: "private",
      },
    ])("fails malformed URL results with $label without retaining returned content", async ({ result, privateValue }) => {
      const { store, clientKey, runId } = createRun({ elicitation: { url: {} } });
      await runUrlElicitationProbe(
        makeClient({
          elicitInput: async () => result as unknown as ElicitResult,
        }),
        store,
        clientKey,
        runId,
        DEFAULT_PROBE_TIMEOUTS,
      );

      const probeResult = store.getSnapshotForClient(clientKey, runId).report.probes.elicitationUrl;
      expect(probeResult).toEqual({
        status: "failed",
        code: "elicitation.url_invalid_result",
        message: "URL elicitation returned an invalid result.",
      });
      expect(JSON.stringify(probeResult)).not.toContain(privateValue);
    });

    it("fails programmatic AbortError URL elicitation without treating it as a user decline", async () => {
      const { store, clientKey, runId } = createRun({ elicitation: { url: {} } });
      await runUrlElicitationProbe(
        makeClient({
          elicitInput: async () => {
            throw { name: "AbortError", message: "private abort payload" };
          },
        }),
        store,
        clientKey,
        runId,
        DEFAULT_PROBE_TIMEOUTS,
      );

      expect(store.getSnapshotForClient(clientKey, runId).report.probes.elicitationUrl).toEqual({
        status: "failed",
        code: "elicitation.url_aborted",
        message: "URL elicitation was aborted.",
      });
    });

    it.each([
      ["form", ErrorCode.RequestTimeout, "elicitation.form_timeout", "Form elicitation timed out."],
      [
        "form",
        ErrorCode.MethodNotFound,
        "elicitation.form_not_implemented",
        "Form elicitation was advertised but is not implemented.",
      ],
      ["form", ErrorCode.InternalError, "elicitation.form_request_failed", "Form elicitation failed."],
      ["url", ErrorCode.RequestTimeout, "elicitation.url_timeout", "URL elicitation timed out."],
      [
        "url",
        ErrorCode.MethodNotFound,
        "elicitation.url_not_implemented",
        "URL elicitation was advertised but is not implemented.",
      ],
      ["url", ErrorCode.InternalError, "elicitation.url_request_failed", "URL elicitation failed."],
    ] as const)(
      "classifies %s elicitation protocol error %s without payload leakage",
      async (kind, errorCode, code, message) => {
        const capabilities =
          kind === "form" ? { elicitation: {} } : { elicitation: { url: {} } };
        const { store, clientKey, runId } = createRun(capabilities);
        const client = makeClient({
          elicitInput: async () => {
            throw new McpError(errorCode, "private elicitation error", { secret: "private-token" });
          },
        });

        if (kind === "form") {
          await runFormElicitationProbe(client, store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);
        } else {
          await runUrlElicitationProbe(client, store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS);
        }

        const result =
          store.getSnapshotForClient(clientKey, runId).report.probes[
            kind === "form" ? "elicitationForm" : "elicitationUrl"
          ];
        expect(result).toEqual({ status: "failed", code, message });
        expect(JSON.stringify(result)).not.toContain("private");
      },
    );
  });

  describe("runCapabilityProbes", () => {
    it("runs strictly sequentially, toggles each pending interactive probe, and forwards relatedTask", async () => {
      const { store, clientKey, runId } = createRun({
        roots: {},
        sampling: { tools: {} },
        elicitation: { form: {}, url: {} },
      });
      const events: string[] = [];
      let samplingCall = 0;
      const task: CapabilityTaskProbeContext = {
        taskId: "task-sequential",
        setInputRequired: async () => {
          events.push("input_required");
        },
        setWorking: async () => {
          events.push("working");
        },
      };
      const listRoots = vi.fn(async (_params, options) => {
        events.push("roots");
        expect(options?.relatedTask).toEqual({ taskId: task.taskId });
        return { roots: [] };
      });
      const createMessage = vi.fn(async (params, options) => {
        expect(options?.relatedTask).toEqual({ taskId: task.taskId });
        samplingCall += 1;
        if (samplingCall === 1) {
          events.push("basic");
          return { model: "model", role: "assistant", content: { type: "text", text: "ack" } };
        }
        if (samplingCall === 2) {
          events.push("tools-first");
          return {
            model: "model",
            role: "assistant",
            content: { type: "tool_use", id: "id-1", name: "capability_echo", input: { value: "secret" } },
          };
        }
        events.push("tools-final");
        expect(params.toolChoice).toEqual({ mode: "none" });
        return { model: "model", role: "assistant", content: { type: "text", text: "done" } };
      });
      const elicitInput = vi.fn(async (params, options) => {
        expect(options?.relatedTask).toEqual({ taskId: task.taskId });
        events.push(params.mode === "url" ? "url" : "form");
        return params.mode === "url"
          ? ({ action: "accept" } as ElicitResult)
          : ({ action: "accept", content: { confirmed: false } } as ElicitResult);
      });

      await runCapabilityProbes(
        makeClient({ listRoots, createMessage, elicitInput }),
        store,
        clientKey,
        runId,
        DEFAULT_PROBE_TIMEOUTS,
        task,
      );

      expect(events).toEqual([
        "roots",
        "input_required",
        "basic",
        "working",
        "input_required",
        "tools-first",
        "tools-final",
        "working",
        "input_required",
        "form",
        "working",
        "input_required",
        "url",
        "working",
      ]);
    });

    it("does not toggle unsupported interactive probes", async () => {
      const { store, clientKey, runId } = createRun({ roots: {} });
      const task: CapabilityTaskProbeContext = {
        taskId: "task-unsupported",
        setInputRequired: vi.fn(async () => undefined),
        setWorking: vi.fn(async () => undefined),
      };

      await runCapabilityProbes(
        makeClient(),
        store,
        clientKey,
        runId,
        DEFAULT_PROBE_TIMEOUTS,
        task,
      );

      expect(task.setInputRequired).not.toHaveBeenCalled();
      expect(task.setWorking).not.toHaveBeenCalled();
    });

    it("restores working state in finally when a probe boundary throws", async () => {
      const { store, clientKey, runId } = createRun({ sampling: {} });
      vi.spyOn(store, "updateProbe").mockImplementation(() => {
        throw new Error("controlled boundary failure");
      });
      const task: CapabilityTaskProbeContext = {
        taskId: "task-finally",
        setInputRequired: vi.fn(async () => undefined),
        setWorking: vi.fn(async () => undefined),
      };

      await expect(
        runCapabilityProbes(makeClient(), store, clientKey, runId, DEFAULT_PROBE_TIMEOUTS, task),
      ).rejects.toThrow("controlled boundary failure");

      expect(task.setInputRequired).toHaveBeenCalledTimes(1);
      expect(task.setWorking).toHaveBeenCalledTimes(1);
    });
  });

describe("runBasicSamplingProbe errors and privacy", () => {
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
