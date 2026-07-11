import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestTaskStore } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
  type Task,
} from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_CAPABILITY_RUN_TTL_MS,
  CapabilityRunStoreError,
  type CapabilityRun,
  type CapabilityRunStore,
} from "./capabilityRuns.js";
import type { CapabilityTaskStore } from "./capabilityTaskStore.js";
import {
  DEFAULT_PROBE_TIMEOUTS,
  MCP_APPS_MIME_TYPE,
  createInitialCapabilityReport,
  runCapabilityProbes,
  type CapabilityProbeTimeouts,
} from "./capabilityProbes.js";
import { toCapabilityToolResult } from "./capabilityReport.js";
import { describeShape, loadToolMeta } from "./toolMeta.js";
import { toolShapes } from "./toolSchemas.js";

export const CAPABILITIES_APP_URI = "ui://open-knowledge-hub/capabilities";

const CAPABILITIES_APP = new URL("../../resources/apps/capabilities.html", import.meta.url);
const DEFAULT_CANCELLATION_TTL_MS = 5 * 60_000;
const DEFAULT_TASK_POLL_INTERVAL_MS = 500;
const INPUT_REQUIRED_MESSAGE = "Waiting for client interaction.";
const FAILED_RESULT: CallToolResult = {
  content: [{ type: "text", text: "Capability diagnostic failed." }],
  isError: true,
};

export type AppCapabilityReport = {
  initialized: true;
  theme: "provided" | "absent";
  resize: "observed" | "fixed_container" | "unobserved";
};

export type CapabilityAction = "scan" | "app_report" | "task_cancel" | "report";

export type CapabilityArguments = {
  action?: CapabilityAction;
  runId?: string;
  app?: AppCapabilityReport;
};

type ValidatedCapabilityArguments =
  | { action: "scan" }
  | { action: "app_report"; runId: string; app: AppCapabilityReport }
  | { action: "task_cancel"; runId: string }
  | { action: "report"; runId: string };

export type CapabilityRegistrationTimeouts = CapabilityProbeTimeouts & {
  cancellationTtlMs: number;
  taskPollIntervalMs: number;
};

export type CapabilityRegistrationOptions = {
  runs: CapabilityRunStore;
  tasks: CapabilityTaskStore;
  clientKey?: object;
  timeouts?: Partial<CapabilityRegistrationTimeouts>;
};

function invalid(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

function validateAction(args: CapabilityArguments): ValidatedCapabilityArguments {
  const action = args.action ?? "scan";
  if (action === "scan") {
    if (args.runId !== undefined || args.app !== undefined) {
      invalid("scan does not accept runId or app.");
    }
    return { action };
  }

  if (args.runId === undefined) {
    invalid(`${action} requires runId.`);
  }
  if (action === "app_report") {
    if (args.app === undefined) {
      invalid("app_report requires app.");
    }
    return { action, runId: args.runId, app: args.app };
  }
  if (args.app !== undefined) {
    invalid(`${action} does not accept app.`);
  }
  return { action, runId: args.runId };
}

function registrationTimeouts(
  overrides: Partial<CapabilityRegistrationTimeouts> | undefined,
): CapabilityRegistrationTimeouts {
  return {
    machineMs: overrides?.machineMs ?? DEFAULT_PROBE_TIMEOUTS.machineMs,
    samplingMs: overrides?.samplingMs ?? DEFAULT_PROBE_TIMEOUTS.samplingMs,
    elicitationMs: overrides?.elicitationMs ?? DEFAULT_PROBE_TIMEOUTS.elicitationMs,
    cancellationTtlMs: overrides?.cancellationTtlMs ?? DEFAULT_CANCELLATION_TTL_MS,
    taskPollIntervalMs: overrides?.taskPollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS,
  };
}

function accessibleRun(
  runs: CapabilityRunStore,
  clientKey: object,
  runId: string,
): CapabilityRun {
  try {
    return runs.getRunForClient(clientKey, runId);
  } catch (error) {
    if (error instanceof CapabilityRunStoreError) {
      if (error.code === "missing") invalid("Capability run was not found.");
      if (error.code === "expired") invalid("Capability run has expired.");
      if (error.code === "cross_client") {
        invalid("Capability run is not accessible from this client.");
      }
    }
    throw error;
  }
}

function taskTtl(run: CapabilityRun): number {
  const ttl = Date.parse(run.expiresAt) - Date.parse(run.createdAt);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_CAPABILITY_RUN_TTL_MS;
}

function hasPendingInteractiveProbe(run: CapabilityRun): boolean {
  return [
    run.report.probes.samplingBasic,
    run.report.probes.samplingTools,
    run.report.probes.elicitationForm,
    run.report.probes.elicitationUrl,
  ].some((probe) => probe.status === "pending");
}

function isExpectedRunLifecycleError(error: unknown): boolean {
  return (
    error instanceof CapabilityRunStoreError &&
    (error.code === "missing" || error.code === "expired")
  );
}

function isExpectedAbortError(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (
    error instanceof McpError &&
    error.code === ErrorCode.InvalidRequest &&
    error.message === `MCP error ${ErrorCode.InvalidRequest}: Request cancelled`
  ) {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}

function isTerminal(status: Task["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

async function taskStoppedAfterAbort(
  taskStore: RequestTaskStore,
  taskId: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (!signal.aborted) return false;
  try {
    return isTerminal((await taskStore.getTask(taskId)).status);
  } catch (error) {
    if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
      return true;
    }
    throw error;
  }
}

function appThemeProbe(theme: AppCapabilityReport["theme"]) {
  return theme === "provided"
    ? {
        status: "passed" as const,
        code: "apps.theme",
        message: "Host supplied theme context.",
      }
    : {
        status: "unsupported" as const,
        code: "apps.theme",
        message: "Host supplied no theme context.",
      };
}

function appResizeProbe(resize: AppCapabilityReport["resize"]) {
  if (resize === "observed") {
    return {
      status: "passed" as const,
      code: "apps.resize",
      message: "Host container dimensions changed.",
    };
  }
  if (resize === "fixed_container") {
    return {
      status: "supported_not_completed" as const,
      code: "apps.resize",
      message: "Host declared a fixed container.",
    };
  }
  return {
    status: "failed" as const,
    code: "apps.resize",
    message: "No resize outcome was observable.",
  };
}

async function registerCapabilitiesResource(server: McpServer): Promise<void> {
  const html = await readFile(CAPABILITIES_APP, "utf8");
  const uiMeta = { ui: { prefersBorder: true } };
  server.registerResource(
    "MCP Client Capabilities",
    CAPABILITIES_APP_URI,
    {
      title: "MCP Client Capabilities",
      mimeType: MCP_APPS_MIME_TYPE,
      _meta: uiMeta,
    },
    async () => ({
      contents: [{
        uri: CAPABILITIES_APP_URI,
        mimeType: MCP_APPS_MIME_TYPE,
        text: html,
        _meta: uiMeta,
      }],
    }),
  );
}

export async function registerCapabilities(
  server: McpServer,
  options: CapabilityRegistrationOptions,
): Promise<void> {
  const meta = await loadToolMeta("capabilities");
  const timeouts = registrationTimeouts(options.timeouts);
  const clientKey = options.clientKey ?? {};
  const { runs, tasks } = options;

  await registerCapabilitiesResource(server);

  server.experimental.tasks.registerToolTask(
    "capabilities",
    {
      title: meta.title,
      description: meta.description,
      inputSchema: describeShape(toolShapes.capabilities, meta.args),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      execution: { taskSupport: "optional" },
      _meta: {
        ui: {
          resourceUri: CAPABILITIES_APP_URI,
          visibility: ["model", "app"],
        },
        "ui/resourceUri": CAPABILITIES_APP_URI,
      },
    },
    {
      createTask: async (rawArgs, extra) => {
        const args = validateAction(rawArgs);
        const run = args.action === "scan"
          ? runs.createRun(clientKey, (context) =>
              createInitialCapabilityReport(
                context,
                server.server.getClientCapabilities() ?? {},
                server.server.getClientVersion(),
              ))
          : accessibleRun(runs, clientKey, args.runId);
        const task = await extra.taskStore.createTask({
          ttl: args.action === "task_cancel" ? timeouts.cancellationTtlMs : taskTtl(run),
          pollInterval: timeouts.taskPollIntervalMs,
          context: {
            kind: "capabilities",
            runId: run.id,
            action: args.action,
            clientKey,
          },
        });

        if (args.action === "scan") {
          const abortRun = () => {
            try {
              runs.abortRun(clientKey, run.id);
            } catch (error) {
              if (!isExpectedRunLifecycleError(error)) {
                process.stderr.write("Capability run abort failed.\n");
              }
            }
          };
          if (extra.signal.aborted) {
            abortRun();
          } else {
            extra.signal.addEventListener("abort", abortRun, { once: true });
          }
        }

        const execute = async (): Promise<void> => {
          if (args.action === "scan") {
            const current = runs.getRunForClient(clientKey, run.id);
            const taskAugmented = tasks.isTaskAugmented(task.taskId);
            const interactivePending = hasPendingInteractiveProbe(current);
            await runCapabilityProbes(
              {
                listRoots: (_params, requestOptions) =>
                  server.server.listRoots(undefined, requestOptions),
                createMessage: (params, requestOptions) =>
                  server.server.createMessage(params, requestOptions),
                elicitInput: (params, requestOptions) =>
                  server.server.elicitInput(params, requestOptions),
              },
              runs,
              clientKey,
              run.id,
              timeouts,
              taskAugmented && interactivePending
                ? {
                    taskId: task.taskId,
                    setInputRequired: () =>
                      extra.taskStore.updateTaskStatus(
                        task.taskId,
                        "input_required",
                        INPUT_REQUIRED_MESSAGE,
                      ),
                    setWorking: async () => {
                      try {
                        await extra.taskStore.updateTaskStatus(task.taskId, "working");
                      } catch (error) {
                        if (!(await taskStoppedAfterAbort(
                          extra.taskStore,
                          task.taskId,
                          current.signal,
                        ))) {
                          throw error;
                        }
                      }
                    },
                  }
                : undefined,
            );
            await extra.taskStore.storeTaskResult(
              task.taskId,
              "completed",
              toCapabilityToolResult(
                runs.getSnapshotForClient(clientKey, run.id).report,
              ),
            );
            return;
          }

          if (args.action === "app_report") {
            runs.replaceProbe(clientKey, run.id, "appInitialize", {
              status: "passed",
              code: "apps.initialize",
              message: "MCP App initialized and called the server.",
            });
            runs.replaceProbe(
              clientKey,
              run.id,
              "appTheme",
              appThemeProbe(args.app.theme),
            );
            runs.replaceProbe(
              clientKey,
              run.id,
              "appResize",
              appResizeProbe(args.app.resize),
            );
            await extra.taskStore.storeTaskResult(
              task.taskId,
              "completed",
              toCapabilityToolResult(
                runs.getSnapshotForClient(clientKey, run.id).report,
              ),
            );
            return;
          }

          if (args.action === "report") {
            await extra.taskStore.storeTaskResult(
              task.taskId,
              "completed",
              toCapabilityToolResult(
                runs.getSnapshotForClient(clientKey, run.id).report,
              ),
            );
            return;
          }

          if (!tasks.isTaskAugmented(task.taskId)) {
            runs.replaceProbe(clientKey, run.id, "tasksCancel", {
              status: "not_exercised",
              code: "tasks.cancel",
              message: "Task cancellation requires a task-augmented call.",
            });
            await extra.taskStore.storeTaskResult(
              task.taskId,
              "completed",
              toCapabilityToolResult(
                runs.getSnapshotForClient(clientKey, run.id).report,
              ),
            );
            return;
          }

          tasks.armCancellationTimeout(task.taskId, timeouts.cancellationTtlMs);
        };

        void execute().catch(async (error: unknown) => {
          if (
            isExpectedRunLifecycleError(error) ||
            isExpectedAbortError(error, run.signal)
          ) {
            return;
          }
          try {
            await extra.taskStore.storeTaskResult(task.taskId, "failed", FAILED_RESULT);
          } catch {
            try {
              if (await taskStoppedAfterAbort(
                extra.taskStore,
                task.taskId,
                run.signal,
              )) {
                return;
              }
            } catch {
              process.stderr.write("Capability task state check failed.\n");
              return;
            }
            process.stderr.write("Capability task result could not be stored.\n");
          }
        });

        return { task };
      },
      getTask: async (_args, extra) => {
        tasks.markPolled(extra.taskId);
        return extra.taskStore.getTask(extra.taskId);
      },
      getTaskResult: async (_args, extra) => {
        const dynamic = tasks.markResultRequested(extra.taskId);
        if (dynamic !== undefined) {
          return CallToolResultSchema.parse(dynamic);
        }
        return CallToolResultSchema.parse(
          await extra.taskStore.getTaskResult(extra.taskId),
        );
      },
    },
  );
}
