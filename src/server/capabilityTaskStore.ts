import type {
  CreateTaskOptions,
  TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import {
  CallToolRequestSchema,
  type Request,
  type RequestId,
  type Result,
  type Task,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CapabilityRunStoreError,
  type CapabilityRunStore,
} from "./capabilityRuns.js";

type CapabilityTaskAction = "scan" | "app_report" | "task_cancel" | "report";

type CapabilityTaskContext = {
  kind: "capabilities";
  runId: string;
  action: CapabilityTaskAction;
  clientKey: object;
};

type PublicCapabilityTaskContext = Omit<CapabilityTaskContext, "clientKey">;

type TaskBinding = CapabilityTaskContext & {
  taskAugmented: boolean;
};

const DEFAULT_MAX_BINDINGS = 128;

export type CapabilityTaskStoreOptions = {
  maxBindings?: number;
};

const TASK_PROBES = {
  createPassed: {
    status: "passed",
    code: "tasks.create",
    message: "Task-augmented capability scan was created.",
  },
  pollPending: {
    status: "pending",
    code: "tasks.poll",
    message: "External task polling is pending.",
  },
  pollPassed: {
    status: "passed",
    code: "tasks.poll",
    message: "External task status was requested.",
  },
  pollSkipped: {
    status: "supported_not_completed",
    code: "tasks.poll",
    message: "Task result was requested without a preceding external status poll.",
  },
  inputPending: {
    status: "pending",
    code: "tasks.input",
    message: "Task input-required observation is pending.",
  },
  inputPassed: {
    status: "passed",
    code: "tasks.input",
    message: "Task entered input_required during interactive capability probing.",
  },
  resultPending: {
    status: "pending",
    code: "tasks.result",
    message: "External task result retrieval is pending.",
  },
  resultPassed: {
    status: "passed",
    code: "tasks.result",
    message: "External task result was requested.",
  },
  cancelPending: {
    status: "pending",
    code: "tasks.cancel",
    message: "External task cancellation is pending.",
  },
  cancelPassed: {
    status: "passed",
    code: "tasks.cancel",
    message: "Client cancelled the diagnostic task.",
  },
  cancelTimedOut: {
    status: "supported_not_completed",
    code: "tasks.cancel",
    message: "Cancellation task timed out before external cancellation was observed.",
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapabilityTaskAction(value: unknown): value is CapabilityTaskAction {
  return value === "scan" || value === "app_report" || value === "task_cancel" || value === "report";
}

function capabilityContext(value: unknown): CapabilityTaskContext | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind !== "capabilities") return undefined;
  if (typeof value.runId !== "string") return undefined;
  if (!isCapabilityTaskAction(value.action)) return undefined;
  if (typeof value.clientKey !== "object" || value.clientKey === null || Array.isArray(value.clientKey)) {
    return undefined;
  }
  return {
    kind: "capabilities",
    runId: value.runId,
    action: value.action,
    clientKey: value.clientKey,
  };
}

function publicCapabilityContext(context: CapabilityTaskContext): PublicCapabilityTaskContext {
  return {
    kind: "capabilities",
    runId: context.runId,
    action: context.action,
  };
}

function sanitizedCreateTaskOptions(
  options: CreateTaskOptions,
  context: CapabilityTaskContext | undefined,
): CreateTaskOptions {
  if (context !== undefined) {
    return {
      ...options,
      context: publicCapabilityContext(context),
    };
  }

  if (!("context" in options)) return options;
  if (!isRecord(options.context) || options.context.kind !== "capabilities") return options;

  const { context: _context, ...sanitizedOptions } = options;
  return sanitizedOptions;
}

function validateMaxBindings(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError("Capability task maxBindings must be a positive integer.");
  }
  return value;
}

function isExpectedRunAccessError(error: unknown): boolean {
  return (
    error instanceof CapabilityRunStoreError &&
    (error.code === "missing" || error.code === "expired" || error.code === "cross_client")
  );
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate: unknown = timer;
  if (typeof candidate !== "object" || candidate === null || !("unref" in candidate)) return;
  const unref = candidate.unref;
  if (typeof unref === "function") {
    unref.call(candidate);
  }
}

export class CapabilityTaskStore implements TaskStore {
  private readonly bindings = new Map<string, TaskBinding>();
  private readonly cancellationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly maxBindings: number;
  private delegateCleanedUp = false;

  constructor(
    private readonly delegate: TaskStore,
    private readonly runs: CapabilityRunStore,
    private readonly renderResult: (runId: string, clientKey: object) => Result,
    options: CapabilityTaskStoreOptions = {},
  ) {
    this.maxBindings = validateMaxBindings(options.maxBindings ?? DEFAULT_MAX_BINDINGS);
  }

  async createTask(
    options: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    sessionId?: string,
  ): Promise<Task> {
    const context = capabilityContext(options.context);
    const task = await this.delegate.createTask(sanitizedCreateTaskOptions(options, context), requestId, request, sessionId);
    if (context === undefined) return task;

    const parsedRequest = CallToolRequestSchema.safeParse(request);
    const binding: TaskBinding = {
      ...context,
      taskAugmented: parsedRequest.success && parsedRequest.data.params.task !== undefined,
    };
    this.bindTask(task.taskId, binding);

    if (!binding.taskAugmented) return task;
    if (binding.action === "scan") {
      this.observeRun(() => {
        const current = this.runs.getSnapshotForClient(binding.clientKey, binding.runId).report;
        const hasPendingInteractiveProbe = [
          current.probes.samplingBasic,
          current.probes.samplingTools,
          current.probes.elicitationForm,
          current.probes.elicitationUrl,
        ].some((probe) => probe.status === "pending");

        this.runs.replaceProbe(binding.clientKey, binding.runId, "tasksCreate", TASK_PROBES.createPassed);
        this.runs.replaceProbe(binding.clientKey, binding.runId, "tasksPoll", TASK_PROBES.pollPending);
        this.runs.replaceProbe(binding.clientKey, binding.runId, "tasksResult", TASK_PROBES.resultPending);
        if (hasPendingInteractiveProbe) {
          this.runs.replaceProbe(binding.clientKey, binding.runId, "tasksInput", TASK_PROBES.inputPending);
        }
        this.runs.associateTaskId(binding.clientKey, binding.runId, task.taskId);
      });
    } else if (binding.action === "task_cancel") {
      this.observeRun(() => {
        this.runs.replaceProbe(binding.clientKey, binding.runId, "tasksCancel", TASK_PROBES.cancelPending);
        this.runs.associateTaskId(binding.clientKey, binding.runId, task.taskId);
      });
    }

    return task;
  }

  getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    return this.delegate.getTask(taskId, sessionId);
  }

  async storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    await this.delegate.storeTaskResult(taskId, status, result, sessionId);
  }

  getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    return this.delegate.getTaskResult(taskId, sessionId);
  }

  async updateTaskStatus(
    taskId: string,
    status: Task["status"],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await this.delegate.updateTaskStatus(taskId, status, statusMessage, sessionId);

    if (status === "cancelled") {
      this.clearCancellationTimer(taskId);
    }

    const binding = this.bindings.get(taskId);
    if (binding === undefined || !binding.taskAugmented) return;

    if (binding.action === "scan" && status === "input_required") {
      this.observeRun(() => {
        const current = this.runs.getSnapshotForClient(binding.clientKey, binding.runId);
        if (current.report.probes.tasksInput.status === "pending") {
          this.runs.replaceProbe(binding.clientKey, binding.runId, "tasksInput", TASK_PROBES.inputPassed);
        }
      });
    } else if (binding.action === "task_cancel" && status === "cancelled") {
      this.observeRun(() => {
        this.runs.replaceProbe(binding.clientKey, binding.runId, "tasksCancel", TASK_PROBES.cancelPassed);
        this.runs.abortRun(binding.clientKey, binding.runId);
      });
      this.bindings.delete(taskId);
    }
  }

  listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    return this.delegate.listTasks(cursor, sessionId);
  }

  isTaskAugmented(taskId: string): boolean {
    return this.bindings.get(taskId)?.taskAugmented ?? false;
  }

  markPolled(taskId: string): void {
    const binding = this.bindings.get(taskId);
    if (binding === undefined || !binding.taskAugmented || binding.action !== "scan") return;
    this.observeRun(() => {
      this.runs.replaceProbe(binding.clientKey, binding.runId, "tasksPoll", TASK_PROBES.pollPassed);
    });
  }

  markResultRequested(taskId: string): Result | undefined {
    const binding = this.bindings.get(taskId);
    if (binding === undefined || !binding.taskAugmented || binding.action !== "scan") return undefined;

    return this.observeRun(() => {
      const current = this.runs.getSnapshotForClient(binding.clientKey, binding.runId);
      if (current.report.probes.tasksPoll.status === "pending") {
        this.runs.replaceProbe(binding.clientKey, binding.runId, "tasksPoll", TASK_PROBES.pollSkipped);
      }
      this.runs.replaceProbe(binding.clientKey, binding.runId, "tasksResult", TASK_PROBES.resultPassed);
      return this.renderResult(binding.runId, binding.clientKey);
    });
  }

  armCancellationTimeout(taskId: string, timeoutMs: number): void {
    const binding = this.bindings.get(taskId);
    if (binding === undefined || !binding.taskAugmented || binding.action !== "task_cancel") return;

    this.clearCancellationTimer(taskId);
    const timer = setTimeout(() => {
      this.cancellationTimers.delete(taskId);
      this.observeRun(() => {
        const current = this.runs.getSnapshotForClient(binding.clientKey, binding.runId);
        if (current.report.probes.tasksCancel.status === "pending") {
          this.runs.replaceProbe(binding.clientKey, binding.runId, "tasksCancel", TASK_PROBES.cancelTimedOut);
        }
      });
    }, timeoutMs);
    unrefTimer(timer);
    this.cancellationTimers.set(taskId, timer);
  }

  cleanup(): void {
    for (const timer of this.cancellationTimers.values()) {
      clearTimeout(timer);
    }
    this.cancellationTimers.clear();
    this.bindings.clear();

    const candidate: unknown = this.delegate;
    if (this.delegateCleanedUp) return;
    if (typeof candidate !== "object" || candidate === null || !("cleanup" in candidate)) return;
    const cleanup = candidate.cleanup;
    if (typeof cleanup === "function") {
      this.delegateCleanedUp = true;
      cleanup.call(candidate);
    }
  }

  private clearCancellationTimer(taskId: string): void {
    const timer = this.cancellationTimers.get(taskId);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    this.cancellationTimers.delete(taskId);
  }

  private bindTask(taskId: string, binding: TaskBinding): void {
    this.clearCancellationTimer(taskId);
    this.bindings.delete(taskId);
    this.bindings.set(taskId, binding);
    this.evictOverflowBindings();
  }

  private evictOverflowBindings(): void {
    while (this.bindings.size > this.maxBindings) {
      const oldestTaskId = this.bindings.keys().next().value;
      if (oldestTaskId === undefined) return;
      this.clearCancellationTimer(oldestTaskId);
      this.bindings.delete(oldestTaskId);
    }
  }

  private observeRun<T>(observation: () => T): T | undefined {
    try {
      return observation();
    } catch (error) {
      if (isExpectedRunAccessError(error)) return undefined;
      throw error;
    }
  }
}
