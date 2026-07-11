import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ErrorCode,
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
  return /abort|cancel|declin|deni|reject|not approved/i.test(errorText(error));
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
