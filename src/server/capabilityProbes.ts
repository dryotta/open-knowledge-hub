import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ErrorCode,
  CreateMessageResultWithToolsSchema,
  ElicitResultSchema,
  LATEST_PROTOCOL_VERSION,
  type ClientCapabilities,
  type CreateMessageRequestParams,
  type CreateMessageResult,
  type CreateMessageResultWithTools,
  type ElicitRequestFormParams,
  type ElicitRequestURLParams,
  type ElicitResult,
  type Implementation,
  type ListRootsResult,
  type RelatedTaskMetadata,
} from "@modelcontextprotocol/sdk/types.js";
import {
  deriveOverallStatus,
  type CapabilityProbe,
  type CapabilityReport,
} from "./capabilityReport.js";
import type { CapabilityRunContext, CapabilityRunStore } from "./capabilityRuns.js";

export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_APPS_MIME_TYPE = "text/html;profile=mcp-app";

export type CapabilityProbeTimeouts = {
  machineMs: number;
  samplingMs: number;
  elicitationMs: number;
};

export const DEFAULT_PROBE_TIMEOUTS = {
  machineMs: 15_000,
  samplingMs: 5 * 60_000,
  elicitationMs: 10 * 60_000,
} as const satisfies CapabilityProbeTimeouts;

const INTERACTIVE_DECLINE_DECISION_PATTERN = String.raw`(?:cancel(?:led|ed|lation)?|declin(?:ed)?|deni(?:ed|al)?|reject(?:ed|ion)?|not approved)`;
const INTERACTIVE_DECLINE_PATTERN = new RegExp(
  String.raw`(?:\buser\b.{0,40}\b${INTERACTIVE_DECLINE_DECISION_PATTERN}\b|\b${INTERACTIVE_DECLINE_DECISION_PATTERN}\b.{0,40}\bby (?:the )?user\b)`,
  "i",
);

export interface CapabilityProbeClient {
  listRoots(params?: unknown, options?: RequestOptions): Promise<ListRootsResult>;
  createMessage(
    params: CreateMessageRequestParams,
    options?: RequestOptions,
  ): Promise<CreateMessageResult | CreateMessageResultWithTools>;
  elicitInput(
    params: ElicitRequestFormParams | ElicitRequestURLParams,
    options?: RequestOptions,
  ): Promise<ElicitResult>;
}

function probe(status: CapabilityProbe["status"], code: string, message: string): CapabilityProbe {
  return { status, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function supportsMcpApps(capabilities: ClientCapabilities): boolean {
  const extension = capabilities.extensions?.[MCP_APPS_EXTENSION_ID];
  if (!isRecord(extension)) return false;
  if (!Object.prototype.hasOwnProperty.call(extension, "mimeTypes")) return true;

  return Array.isArray(extension.mimeTypes) && extension.mimeTypes.includes(MCP_APPS_MIME_TYPE);
}

function initialProbe(
  supported: boolean,
  code: string,
  pendingMessage: string,
  unsupportedMessage: string,
): CapabilityProbe {
  return supported
    ? probe("pending", code, pendingMessage)
    : probe("unsupported", code, unsupportedMessage);
}

export function createInitialCapabilityReport(
  context: CapabilityRunContext,
  capabilities: ClientCapabilities,
  clientImplementation?: Implementation,
): CapabilityReport {
  void clientImplementation;

  const roots = capabilities.roots !== undefined;
  const rootsListChanged = capabilities.roots?.listChanged === true;
  const sampling = capabilities.sampling !== undefined;
  const samplingTools = capabilities.sampling?.tools !== undefined;
  const elicitation = isRecord(capabilities.elicitation) ? capabilities.elicitation : undefined;
  const elicitationForm =
    elicitation !== undefined &&
    (elicitation.form !== undefined || Object.keys(elicitation).length === 0);
  const elicitationUrl = elicitation?.url !== undefined;
  const tasks = capabilities.tasks !== undefined;
  const apps = supportsMcpApps(capabilities);

  const probes: CapabilityReport["probes"] = {
    roots: initialProbe(roots, "roots.list", "Roots listing is pending.", "Roots are not advertised."),
    samplingBasic: initialProbe(
      sampling,
      "sampling.basic",
      "Basic sampling is pending.",
      "Sampling is not advertised.",
    ),
    samplingTools: initialProbe(
      samplingTools,
      "sampling.tools",
      "Sampling with tools is pending.",
      "Sampling with tools is not advertised.",
    ),
    elicitationForm: initialProbe(
      elicitationForm,
      "elicitation.form",
      "Form elicitation is pending.",
      "Form elicitation is not advertised.",
    ),
    elicitationUrl: initialProbe(
      elicitationUrl,
      "elicitation.url",
      "URL elicitation is pending.",
      "URL elicitation is not advertised.",
    ),
    appInitialize: initialProbe(
      apps,
      "apps.initialize",
      "MCP App initialization is pending.",
      "Compatible MCP Apps support is not advertised.",
    ),
    appTheme: initialProbe(
      apps,
      "apps.theme",
      "MCP App theme handling is pending.",
      "Compatible MCP Apps support is not advertised.",
    ),
    appResize: initialProbe(
      apps,
      "apps.resize",
      "MCP App resize handling is pending.",
      "Compatible MCP Apps support is not advertised.",
    ),
    tasksCreate: probe("not_exercised", "tasks.create", "Task creation is not exercised."),
    tasksPoll: probe("not_exercised", "tasks.poll", "Task polling is not exercised."),
    tasksInput: probe("not_exercised", "tasks.input", "Task input is not exercised."),
    tasksResult: probe("not_exercised", "tasks.result", "Task result retrieval is not exercised."),
    tasksCancel: probe("not_exercised", "tasks.cancel", "Task cancellation is not exercised."),
  };

  return {
    schemaVersion: "1",
    runId: context.id,
    createdAt: context.createdAt,
    expiresAt: context.expiresAt,
    testedProtocolGeneration: LATEST_PROTOCOL_VERSION,
    client: {
      declared: {
        roots,
        rootsListChanged,
        sampling,
        samplingTools,
        elicitationForm,
        elicitationUrl,
        tasks,
      },
    },
    probes,
    overallStatus: deriveOverallStatus(Object.values(probes)),
  };
}

function requestOptions(
  timeout: number,
  signal: AbortSignal,
  relatedTask?: RelatedTaskMetadata,
): RequestOptions {
  return {
    timeout,
    signal,
    ...(relatedTask === undefined ? {} : { relatedTask }),
  };
}

function errorCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "number" ? error.code : undefined;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (!isRecord(error)) return "";

  const name = typeof error.name === "string" ? error.name : "";
  const message = typeof error.message === "string" ? error.message : "";
  return `${name} ${message}`;
}

function isInteractiveDecline(error: unknown): boolean {
  return INTERACTIVE_DECLINE_PATTERN.test(errorText(error));
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function validateRootsResult(result: unknown):
  | { valid: true; count: number; namesObserved: boolean }
  | { valid: false; invalidUri: boolean } {
  if (!isRecord(result) || !Array.isArray(result.roots)) {
    return { valid: false, invalidUri: false };
  }

  let namesObserved = false;
  for (const root of result.roots) {
    if (!isRecord(root) || typeof root.uri !== "string") {
      return { valid: false, invalidUri: false };
    }

    try {
      if (new URL(root.uri).protocol !== "file:") {
        return { valid: false, invalidUri: true };
      }
    } catch {
      return { valid: false, invalidUri: true };
    }

    namesObserved ||= typeof root.name === "string" && root.name.length > 0;
  }

  return { valid: true, count: result.roots.length, namesObserved };
}

export async function runRootsProbe(
  client: CapabilityProbeClient,
  runs: CapabilityRunStore,
  clientKey: object,
  runId: string,
  timeouts: CapabilityProbeTimeouts,
  relatedTask?: RelatedTaskMetadata,
): Promise<void> {
  const run = runs.getRunForClient(clientKey, runId);
  if (run.report.probes.roots.status !== "pending") return;

  try {
    const result = await client.listRoots(undefined, requestOptions(timeouts.machineMs, run.signal, relatedTask));
    const validation = validateRootsResult(result);

    if (!validation.valid) {
      runs.updateProbe(
        clientKey,
        runId,
        "roots",
        validation.invalidUri
          ? probe("failed", "roots.invalid_uri", "Roots result included an invalid or non-file URI.")
          : probe("failed", "roots.invalid_result", "Roots listing returned an invalid result."),
      );
      return;
    }

    runs.updateProbe(clientKey, runId, "roots", {
      status: "passed",
      code: "roots.list_passed",
      message: validation.namesObserved
        ? "Roots listed successfully; display names were observed."
        : "Roots listed successfully; no display names were observed.",
      evidence: { kind: "count", value: validation.count },
    });
  } catch (error) {
    const code = errorCode(error);
    const result =
      code === ErrorCode.RequestTimeout
        ? probe("failed", "roots.timeout", "Roots listing timed out.")
        : code === ErrorCode.MethodNotFound
          ? probe(
              "failed",
              "roots.not_implemented",
              "Roots were advertised but the method is not implemented.",
            )
          : probe("failed", "roots.request_failed", "Roots listing failed.");
    runs.updateProbe(clientKey, runId, "roots", result);
  }
}

function hasAssistantText(result: unknown): boolean {
  if (!isRecord(result) || result.role !== "assistant") return false;
  const content = Array.isArray(result.content) ? result.content : [result.content];
  return content.some(
    (block) =>
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim().length > 0,
  );
}

function hasAssistantToolUse(result: unknown): boolean {
  if (!isRecord(result) || result.role !== "assistant") return false;
  const content = Array.isArray(result.content) ? result.content : [result.content];
  return content.some((block) => isRecord(block) && block.type === "tool_use");
}

function validateSamplingToolsFinalResult(result: unknown): CapabilityProbe {
  if (hasAssistantToolUse(result)) {
    return probe(
      "failed",
      "sampling.tools_invalid_follow_up_tool_use",
      "Sampling returned a follow-up tool use in the final response.",
    );
  }

  return hasAssistantText(result)
    ? {
        status: "passed",
        code: "sampling.tools_passed",
        message: "Sampling completed one synthetic tool call.",
        evidence: { kind: "count", value: 1 },
      }
    : probe("failed", "sampling.tools_invalid_final", "Sampling returned an invalid final response.");
}

export async function runBasicSamplingProbe(
  client: CapabilityProbeClient,
  runs: CapabilityRunStore,
  clientKey: object,
  runId: string,
  timeouts: CapabilityProbeTimeouts,
  relatedTask?: RelatedTaskMetadata,
): Promise<void> {
  const run = runs.getRunForClient(clientKey, runId);
  if (run.report.probes.samplingBasic.status !== "pending") return;

  try {
    const result = await client.createMessage(
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
      requestOptions(timeouts.samplingMs, run.signal, relatedTask),
    );

    runs.updateProbe(
      clientKey,
      runId,
      "samplingBasic",
      hasAssistantText(result)
        ? probe("passed", "sampling.basic_passed", "Basic sampling returned assistant text.")
        : probe("failed", "sampling.invalid_result", "Basic sampling returned an invalid result."),
    );
  } catch (error) {
    const code = errorCode(error);
    const result =
      code === ErrorCode.RequestTimeout
        ? probe("failed", "sampling.timeout", "Basic sampling timed out.")
        : code === ErrorCode.MethodNotFound
          ? probe(
              "failed",
              "sampling.not_implemented",
              "Sampling was advertised but the method is not implemented.",
            )
          : isAbortError(error)
            ? probe("failed", "sampling.aborted", "Basic sampling was aborted.")
          : isInteractiveDecline(error)
            ? probe(
                "supported_not_completed",
                "sampling.not_completed",
                "Basic sampling was supported but not completed by the user.",
              )
            : probe("failed", "sampling.request_failed", "Basic sampling failed.");
    runs.updateProbe(clientKey, runId, "samplingBasic", result);
  }
}

const CAPABILITY_ECHO_TOOL = {
  name: "capability_echo",
  description: "Echo one object to verify sampling tool use.",
  inputSchema: {
    type: "object" as const,
    properties: {
      value: { type: "string" },
    },
    required: ["value"],
    additionalProperties: false,
  },
};

const SAMPLING_TOOLS_USER_MESSAGE = {
  role: "user" as const,
  content: {
    type: "text" as const,
    text: "Call capability_echo exactly once with an object containing value, then summarize success.",
  },
};

type InteractiveErrorMessages = {
  timeout: CapabilityProbe;
  notImplemented: CapabilityProbe;
  aborted: CapabilityProbe;
  notCompleted: CapabilityProbe;
  failed: CapabilityProbe;
};

function classifyInteractiveError(error: unknown, messages: InteractiveErrorMessages): CapabilityProbe {
  const code = errorCode(error);
  if (code === ErrorCode.RequestTimeout) return messages.timeout;
  if (code === ErrorCode.MethodNotFound) return messages.notImplemented;
  if (isAbortError(error)) return messages.aborted;
  if (isInteractiveDecline(error)) return messages.notCompleted;
  return messages.failed;
}

type ToolUseValidation =
  | { valid: true; id: string; assistantContent: CreateMessageResultWithTools["content"] }
  | { valid: false; result: CapabilityProbe };

function validateToolUseResult(result: unknown): ToolUseValidation {
  const validation = CreateMessageResultWithToolsSchema.safeParse(result);
  if (!validation.success) {
    return {
      valid: false,
      result: probe("failed", "sampling.tools_invalid_result", "Sampling returned an invalid tool-use result."),
    };
  }

  if (validation.data.role !== "assistant") {
    return {
      valid: false,
      result: probe("failed", "sampling.tools_missing_tool_use", "Sampling did not return a tool use."),
    };
  }

  const assistantContent = validation.data.content;
  const blocks = Array.isArray(assistantContent) ? assistantContent : [assistantContent];
  const toolUses = blocks.filter((block) => isRecord(block) && block.type === "tool_use");

  if (toolUses.length === 0) {
    return {
      valid: false,
      result: probe("failed", "sampling.tools_missing_tool_use", "Sampling did not return a tool use."),
    };
  }

  const ids = toolUses
    .map((block) => (typeof block.id === "string" && block.id.trim().length > 0 ? block.id : undefined))
    .filter((id): id is string => id !== undefined);
  if (new Set(ids).size !== ids.length) {
    return {
      valid: false,
      result: probe("failed", "sampling.tools_duplicate_id", "Sampling returned duplicate tool-use IDs."),
    };
  }
  if (toolUses.length !== 1) {
    return {
      valid: false,
      result: probe("failed", "sampling.tools_multiple_tool_uses", "Sampling returned more than one tool use."),
    };
  }

  const toolUse = toolUses[0]!;
  if (typeof toolUse.id !== "string" || toolUse.id.trim().length === 0) {
    return {
      valid: false,
      result: probe("failed", "sampling.tools_invalid_id", "Sampling returned an invalid tool-use ID."),
    };
  }
  if (toolUse.name !== CAPABILITY_ECHO_TOOL.name) {
    return {
      valid: false,
      result: probe("failed", "sampling.tools_unknown_tool", "Sampling returned an unknown tool name."),
    };
  }
  if (
    !isRecord(toolUse.input) ||
    typeof toolUse.input.value !== "string" ||
    Object.keys(toolUse.input).length !== 1
  ) {
    return {
      valid: false,
      result: probe("failed", "sampling.tools_invalid_input", "Sampling returned invalid tool input."),
    };
  }

  return {
    valid: true,
    id: toolUse.id,
    assistantContent,
  };
}

export async function runSamplingToolsProbe(
  client: CapabilityProbeClient,
  runs: CapabilityRunStore,
  clientKey: object,
  runId: string,
  timeouts: CapabilityProbeTimeouts,
  relatedTask?: RelatedTaskMetadata,
): Promise<void> {
  const run = runs.getRunForClient(clientKey, runId);
  if (run.report.probes.samplingTools.status !== "pending") return;

  try {
    const options = requestOptions(timeouts.samplingMs, run.signal, relatedTask);
    const firstResult = await client.createMessage(
      {
        messages: [SAMPLING_TOOLS_USER_MESSAGE],
        includeContext: "none",
        maxTokens: 64,
        tools: [CAPABILITY_ECHO_TOOL],
        toolChoice: { mode: "required" },
      },
      options,
    );
    const toolUse = validateToolUseResult(firstResult);
    if (!toolUse.valid) {
      runs.updateProbe(clientKey, runId, "samplingTools", toolUse.result);
      return;
    }

    const finalResult = await client.createMessage(
      {
        messages: [
          SAMPLING_TOOLS_USER_MESSAGE,
          {
            role: "assistant",
            content: toolUse.assistantContent,
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: toolUse.id,
                content: [{ type: "text", text: "capability_echo completed" }],
              },
            ],
          },
        ],
        includeContext: "none",
        maxTokens: 64,
        tools: [CAPABILITY_ECHO_TOOL],
        toolChoice: { mode: "none" },
      },
      options,
    );

    runs.updateProbe(
      clientKey,
      runId,
      "samplingTools",
      validateSamplingToolsFinalResult(finalResult),
    );
  } catch (error) {
    runs.updateProbe(
      clientKey,
      runId,
      "samplingTools",
      classifyInteractiveError(error, {
        timeout: probe("failed", "sampling.tools_timeout", "Sampling with tools timed out."),
        notImplemented: probe(
          "failed",
          "sampling.tools_not_implemented",
          "Sampling with tools was advertised but is not implemented.",
        ),
        aborted: probe("failed", "sampling.tools_aborted", "Sampling with tools was aborted."),
        notCompleted: probe(
          "supported_not_completed",
          "sampling.tools_not_completed",
          "Sampling with tools was supported but not completed by the user.",
        ),
        failed: probe("failed", "sampling.tools_request_failed", "Sampling with tools failed."),
      }),
    );
  }
}

type ElicitationKind = "form" | "url";

function elicitationErrorProbe(kind: ElicitationKind, error: unknown): CapabilityProbe {
  const label = kind === "form" ? "Form elicitation" : "URL elicitation";
  return classifyInteractiveError(error, {
    timeout: probe("failed", `elicitation.${kind}_timeout`, `${label} timed out.`),
    notImplemented: probe(
      "failed",
      `elicitation.${kind}_not_implemented`,
      `${label} was advertised but is not implemented.`,
    ),
    aborted: probe("failed", `elicitation.${kind}_aborted`, `${label} was aborted.`),
    notCompleted: probe(
      "supported_not_completed",
      `elicitation.${kind}_not_completed`,
      `${label} was supported but not completed by the user.`,
    ),
    failed: probe("failed", `elicitation.${kind}_request_failed`, `${label} failed.`),
  });
}

function elicitationAction(result: unknown): "accept" | "decline" | "cancel" | undefined {
  if (!isRecord(result)) return undefined;
  return result.action === "accept" || result.action === "decline" || result.action === "cancel"
    ? result.action
    : undefined;
}

function invalidElicitationResultProbe(kind: ElicitationKind): CapabilityProbe {
  const label = kind === "form" ? "Form elicitation" : "URL elicitation";
  return probe("failed", `elicitation.${kind}_invalid_result`, `${label} returned an invalid result.`);
}

function validateElicitationResult(
  kind: ElicitationKind,
  result: unknown,
): { valid: true; result: ElicitResult } | { valid: false; result: CapabilityProbe } {
  const validation = ElicitResultSchema.safeParse(result);
  if (!validation.success) {
    return { valid: false, result: invalidElicitationResultProbe(kind) };
  }

  return { valid: true, result: validation.data };
}

export async function runFormElicitationProbe(
  client: CapabilityProbeClient,
  runs: CapabilityRunStore,
  clientKey: object,
  runId: string,
  timeouts: CapabilityProbeTimeouts,
  relatedTask?: RelatedTaskMetadata,
): Promise<void> {
  const run = runs.getRunForClient(clientKey, runId);
  if (run.report.probes.elicitationForm.status !== "pending") return;

  try {
    const result = await client.elicitInput(
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
      requestOptions(timeouts.elicitationMs, run.signal, relatedTask),
    );
    const validation = validateElicitationResult("form", result);
    if (!validation.valid) {
      runs.updateProbe(clientKey, runId, "elicitationForm", validation.result);
      return;
    }

    const validatedResult = validation.result;
    const action = elicitationAction(validatedResult);
    let next: CapabilityProbe;
    if (action === "accept") {
      next =
        isRecord(validatedResult.content) && typeof validatedResult.content.confirmed === "boolean"
          ? probe("passed", "elicitation.form_passed", "Form elicitation returned valid confirmation.")
          : probe(
              "failed",
              "elicitation.form_invalid_content",
              "Form elicitation accepted without valid confirmation.",
            );
    } else if (action === "decline" || action === "cancel") {
      next = probe(
        "supported_not_completed",
        "elicitation.form_not_completed",
        "Form elicitation was supported but not completed by the user.",
      );
    } else {
      next = invalidElicitationResultProbe("form");
    }
    runs.updateProbe(clientKey, runId, "elicitationForm", next);
  } catch (error) {
    runs.updateProbe(clientKey, runId, "elicitationForm", elicitationErrorProbe("form", error));
  }
}

export async function runUrlElicitationProbe(
  client: CapabilityProbeClient,
  runs: CapabilityRunStore,
  clientKey: object,
  runId: string,
  timeouts: CapabilityProbeTimeouts,
  relatedTask?: RelatedTaskMetadata,
): Promise<void> {
  const run = runs.getRunForClient(clientKey, runId);
  if (run.report.probes.elicitationUrl.status !== "pending") return;

  try {
    const result = await client.elicitInput(
      {
        mode: "url",
        message: "Open this reserved URL to confirm URL elicitation support.",
        elicitationId: `capabilities-${runId}`,
        url: `https://example.invalid/open-knowledge-hub/capabilities/${encodeURIComponent(runId)}`,
      },
      requestOptions(timeouts.elicitationMs, run.signal, relatedTask),
    );
    const validation = validateElicitationResult("url", result);
    if (!validation.valid) {
      runs.updateProbe(clientKey, runId, "elicitationUrl", validation.result);
      return;
    }

    const action = elicitationAction(validation.result);
    const next =
      action === "accept"
        ? probe("passed", "elicitation.url_passed", "URL elicitation was accepted.")
        : action === "decline" || action === "cancel"
          ? probe(
              "supported_not_completed",
              "elicitation.url_not_completed",
              "URL elicitation was supported but not completed by the user.",
            )
          : invalidElicitationResultProbe("url");
    runs.updateProbe(clientKey, runId, "elicitationUrl", next);
  } catch (error) {
    runs.updateProbe(clientKey, runId, "elicitationUrl", elicitationErrorProbe("url", error));
  }
}

export interface CapabilityTaskProbeContext {
  taskId: string;
  setInputRequired(): Promise<void>;
  setWorking(): Promise<void>;
}

async function runInteractiveProbe(
  runs: CapabilityRunStore,
  clientKey: object,
  runId: string,
  key: "samplingBasic" | "samplingTools" | "elicitationForm" | "elicitationUrl",
  task: CapabilityTaskProbeContext | undefined,
  execute: () => Promise<void>,
): Promise<void> {
  if (runs.getRunForClient(clientKey, runId).report.probes[key].status !== "pending") return;
  if (task === undefined) {
    await execute();
    return;
  }

  await task.setInputRequired();
  try {
    await execute();
  } finally {
    await task.setWorking();
  }
}

export async function runCapabilityProbes(
  client: CapabilityProbeClient,
  runs: CapabilityRunStore,
  clientKey: object,
  runId: string,
  timeouts: CapabilityProbeTimeouts,
  task?: CapabilityTaskProbeContext,
): Promise<void> {
  const relatedTask = task === undefined ? undefined : { taskId: task.taskId };
  await runRootsProbe(client, runs, clientKey, runId, timeouts, relatedTask);
  await runInteractiveProbe(runs, clientKey, runId, "samplingBasic", task, () =>
    runBasicSamplingProbe(client, runs, clientKey, runId, timeouts, relatedTask),
  );
  await runInteractiveProbe(runs, clientKey, runId, "samplingTools", task, () =>
    runSamplingToolsProbe(client, runs, clientKey, runId, timeouts, relatedTask),
  );
  await runInteractiveProbe(runs, clientKey, runId, "elicitationForm", task, () =>
    runFormElicitationProbe(client, runs, clientKey, runId, timeouts, relatedTask),
  );
  await runInteractiveProbe(runs, clientKey, runId, "elicitationUrl", task, () =>
    runUrlElicitationProbe(client, runs, clientKey, runId, timeouts, relatedTask),
  );
}
