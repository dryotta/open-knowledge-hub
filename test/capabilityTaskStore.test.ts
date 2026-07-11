import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type { CallToolRequest, ClientCapabilities, Result } from "@modelcontextprotocol/sdk/types.js";
import type { CreateTaskOptions } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toCapabilityToolResult } from "../src/server/capabilityReport.js";
import { createInitialCapabilityReport } from "../src/server/capabilityProbes.js";
import { CapabilityRunStore } from "../src/server/capabilityRuns.js";
import { CapabilityTaskStore } from "../src/server/capabilityTaskStore.js";

const INTERACTIVE_CAPABILITIES: ClientCapabilities = { sampling: {} };

function request(taskAugmented: boolean): CallToolRequest {
  return {
    method: "tools/call",
    params: {
      name: "capabilities",
      arguments: { privateArgument: "must-not-serialize" },
      ...(taskAugmented ? { task: { ttl: 1_000 } } : {}),
    },
  };
}

function createRun(
  runs: CapabilityRunStore,
  clientKey: object,
  capabilities: ClientCapabilities = INTERACTIVE_CAPABILITIES,
) {
  return runs.createRun(clientKey, (context) =>
    createInitialCapabilityReport(context, capabilities, { name: "test-client", version: "1.0.0" }),
  );
}

function createStore(runs: CapabilityRunStore, delegate = new InMemoryTaskStore()) {
  return {
    delegate,
    store: new CapabilityTaskStore(delegate, runs, (runId, clientKey) =>
      toCapabilityToolResult(runs.getSnapshotForClient(clientKey, runId).report),
    ),
  };
}

class RecordingTaskStore extends InMemoryTaskStore {
  readonly createTaskOptions: CreateTaskOptions[] = [];

  override createTask(...args: Parameters<InMemoryTaskStore["createTask"]>): ReturnType<InMemoryTaskStore["createTask"]> {
    this.createTaskOptions.push(args[0]);
    return super.createTask(...args);
  }
}

function context(clientKey: object, runId: string, action: "scan" | "app_report" | "task_cancel" | "report") {
  return {
    kind: "capabilities",
    runId,
    action,
    clientKey,
    privateContext: "must-not-serialize",
  };
}

describe("CapabilityTaskStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records task-augmented scan creation and pending interactive task evidence", async () => {
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const { store } = createStore(runs);

    const task = await store.createTask(
      { ttl: null, pollInterval: 5, context: context(clientKey, run.id, "scan") },
      1,
      request(true),
    );

    const report = runs.getSnapshotForClient(clientKey, run.id).report;
    expect(store.isTaskAugmented(task.taskId)).toBe(true);
    expect(report.probes.tasksCreate).toEqual({
      status: "passed",
      code: "tasks.create",
      message: "Task-augmented capability scan was created.",
    });
    expect(report.probes.tasksPoll).toEqual({
      status: "pending",
      code: "tasks.poll",
      message: "External task polling is pending.",
    });
    expect(report.probes.tasksResult).toEqual({
      status: "pending",
      code: "tasks.result",
      message: "External task result retrieval is pending.",
    });
    expect(report.probes.tasksInput).toEqual({
      status: "pending",
      code: "tasks.input",
      message: "Task input-required observation is pending.",
    });
    expect(runs.getSnapshotForClient(clientKey, run.id).taskId).toBe(task.taskId);
    store.cleanup();
  });

  it("keeps task input not exercised when no interactive probe is pending", async () => {
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey, {});
    const { store } = createStore(runs);

    await store.createTask(
      { ttl: null, context: context(clientKey, run.id, "scan") },
      1,
      request(true),
    );

    expect(runs.getSnapshotForClient(clientKey, run.id).report.probes.tasksInput).toEqual({
      status: "not_exercised",
      code: "tasks.input",
      message: "Task input is not exercised.",
    });
    store.cleanup();
  });

  it("does not count normal optional-tool task storage or explicit observations", async () => {
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const { store } = createStore(runs);
    const task = await store.createTask(
      { ttl: null, context: context(clientKey, run.id, "scan") },
      1,
      request(false),
    );

    await store.getTask(task.taskId);
    await store.storeTaskResult(task.taskId, "completed", { stale: "delegate-payload" });
    await store.getTaskResult(task.taskId);
    store.markPolled(task.taskId);
    expect(store.markResultRequested(task.taskId)).toBeUndefined();

    const probes = runs.getSnapshotForClient(clientKey, run.id).report.probes;
    expect(store.isTaskAugmented(task.taskId)).toBe(false);
    for (const key of ["tasksCreate", "tasksPoll", "tasksInput", "tasksResult", "tasksCancel"] as const) {
      expect(probes[key].status).toBe("not_exercised");
    }
    store.cleanup();
  });

  it("does not count generic delegate reads for an augmented task", async () => {
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const { store } = createStore(runs);
    const task = await store.createTask(
      { ttl: null, context: context(clientKey, run.id, "scan") },
      1,
      request(true),
    );

    await store.getTask(task.taskId);
    await store.storeTaskResult(task.taskId, "completed", { stale: "delegate-payload" });
    await store.getTaskResult(task.taskId);

    const probes = runs.getSnapshotForClient(clientKey, run.id).report.probes;
    expect(probes.tasksPoll.status).toBe("pending");
    expect(probes.tasksResult.status).toBe("pending");
    store.cleanup();
  });

  it("marks an explicit external poll as passed", async () => {
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const { store } = createStore(runs);
    const task = await store.createTask(
      { ttl: null, context: context(clientKey, run.id, "scan") },
      1,
      request(true),
    );

    store.markPolled(task.taskId);

    expect(runs.getSnapshotForClient(clientKey, run.id).report.probes.tasksPoll).toEqual({
      status: "passed",
      code: "tasks.poll",
      message: "External task status was requested.",
    });
    store.cleanup();
  });

  it("returns a fresh current result and records a result requested without a prior poll", async () => {
    const clientKey = { privateClientKey: "must-not-serialize" };
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const { store } = createStore(runs);
    const task = await store.createTask(
      { ttl: null, context: context(clientKey, run.id, "scan") },
      1,
      request(true),
    );
    await store.storeTaskResult(task.taskId, "completed", {
      stale: "delegate-payload",
      raw: { secret: "delegate-secret" },
    });

    const result = store.markResultRequested(task.taskId);

    expect(runs.getSnapshotForClient(clientKey, run.id).report.probes.tasksPoll).toEqual({
      status: "supported_not_completed",
      code: "tasks.poll",
      message: "Task result was requested without a preceding external status poll.",
    });
    expect(runs.getSnapshotForClient(clientKey, run.id).report.probes.tasksResult).toEqual({
      status: "passed",
      code: "tasks.result",
      message: "External task result was requested.",
    });
    expect(result).toMatchObject({
      structuredContent: {
        runId: run.id,
        probes: {
          tasksPoll: { status: "supported_not_completed" },
          tasksResult: { status: "passed" },
        },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("delegate-payload");
    expect(serialized).not.toContain("delegate-secret");
    expect(serialized).not.toContain("must-not-serialize");
    store.cleanup();
  });

  it("delegates only public capability context and keeps private context out of task output", async () => {
    const clientKey = { privateClientKey: "must-not-reach-delegate" };
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const delegate = new RecordingTaskStore();
    const { store } = createStore(runs, delegate);

    const task = await store.createTask(
      {
        ttl: null,
        context: {
          ...context(clientKey, run.id, "scan"),
          privateContext: "must-not-reach-delegate",
          nestedPrivate: { secret: "must-not-reach-delegate" },
        },
      },
      1,
      request(true),
    );
    store.markPolled(task.taskId);
    const result = store.markResultRequested(task.taskId);

    expect(delegate.createTaskOptions).toHaveLength(1);
    expect(delegate.createTaskOptions[0].context).toEqual({
      kind: "capabilities",
      runId: run.id,
      action: "scan",
    });
    const serializedDelegateOptions = JSON.stringify(delegate.createTaskOptions[0]);
    expect(serializedDelegateOptions).not.toContain("clientKey");
    expect(serializedDelegateOptions).not.toContain("privateContext");
    expect(serializedDelegateOptions).not.toContain("nestedPrivate");
    expect(serializedDelegateOptions).not.toContain("must-not-reach-delegate");

    const serializedTaskOutput = JSON.stringify({
      task,
      storedTask: await store.getTask(task.taskId),
      result,
    });
    expect(serializedTaskOutput).not.toContain("clientKey");
    expect(serializedTaskOutput).not.toContain("privateContext");
    expect(serializedTaskOutput).not.toContain("nestedPrivate");
    expect(serializedTaskOutput).not.toContain("must-not-reach-delegate");
    expect(runs.getSnapshotForClient(clientKey, run.id).taskId).toBe(task.taskId);
    store.cleanup();
  });

  it("records input_required only when interactive task evidence is pending", async () => {
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const interactiveRun = createRun(runs, clientKey);
    const nonInteractiveRun = createRun(runs, clientKey, {});
    const { store } = createStore(runs);
    const interactiveTask = await store.createTask(
      { ttl: null, context: context(clientKey, interactiveRun.id, "scan") },
      1,
      request(true),
    );
    const nonInteractiveTask = await store.createTask(
      { ttl: null, context: context(clientKey, nonInteractiveRun.id, "scan") },
      2,
      request(true),
    );

    await store.updateTaskStatus(interactiveTask.taskId, "input_required");
    await store.updateTaskStatus(nonInteractiveTask.taskId, "input_required");

    expect(runs.getSnapshotForClient(clientKey, interactiveRun.id).report.probes.tasksInput).toEqual({
      status: "passed",
      code: "tasks.input",
      message: "Task entered input_required during interactive capability probing.",
    });
    expect(runs.getSnapshotForClient(clientKey, nonInteractiveRun.id).report.probes.tasksInput.status).toBe(
      "not_exercised",
    );
    store.cleanup();
  });

  it("records cancellation and aborts the bound diagnostic run", async () => {
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const { store } = createStore(runs);
    const task = await store.createTask(
      { ttl: null, context: context(clientKey, run.id, "task_cancel") },
      1,
      request(true),
    );

    expect(runs.getSnapshotForClient(clientKey, run.id).report.probes.tasksCancel).toEqual({
      status: "pending",
      code: "tasks.cancel",
      message: "External task cancellation is pending.",
    });
    expect(runs.getSnapshotForClient(clientKey, run.id).taskId).toBe(task.taskId);

    await store.updateTaskStatus(task.taskId, "cancelled");

    expect(runs.getSnapshotForClient(clientKey, run.id).report.probes.tasksCancel).toEqual({
      status: "passed",
      code: "tasks.cancel",
      message: "Client cancelled the diagnostic task.",
    });
    expect(run.signal.aborted).toBe(true);
    store.cleanup();
  });

  it("binds app and report tasks without mutating task probes", async () => {
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const { store } = createStore(runs);
    const before = runs.getSnapshotForClient(clientKey, run.id);
    const appTask = await store.createTask(
      { ttl: null, context: context(clientKey, run.id, "app_report") },
      1,
      request(true),
    );
    const reportTask = await store.createTask(
      { ttl: null, context: context(clientKey, run.id, "report") },
      2,
      request(true),
    );

    store.markPolled(appTask.taskId);
    store.markPolled(reportTask.taskId);
    expect(store.markResultRequested(appTask.taskId)).toBeUndefined();
    expect(store.markResultRequested(reportTask.taskId)).toBeUndefined();
    store.armCancellationTimeout(appTask.taskId, 1);
    store.armCancellationTimeout(reportTask.taskId, 1);

    expect(store.isTaskAugmented(appTask.taskId)).toBe(true);
    expect(store.isTaskAugmented(reportTask.taskId)).toBe(true);
    expect(runs.getSnapshotForClient(clientKey, run.id)).toEqual(before);
    store.cleanup();
  });

  it("times out pending cancellation and cancellation clears a rearmed timer", async () => {
    vi.useFakeTimers();
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const timedOutRun = createRun(runs, clientKey);
    const cancelledRun = createRun(runs, clientKey);
    const { store } = createStore(runs);
    const timedOutTask = await store.createTask(
      { ttl: null, context: context(clientKey, timedOutRun.id, "task_cancel") },
      1,
      request(true),
    );
    const cancelledTask = await store.createTask(
      { ttl: null, context: context(clientKey, cancelledRun.id, "task_cancel") },
      2,
      request(true),
    );

    store.armCancellationTimeout(timedOutTask.taskId, 10);
    store.armCancellationTimeout(timedOutTask.taskId, 20);
    store.armCancellationTimeout(cancelledTask.taskId, 20);
    await store.updateTaskStatus(cancelledTask.taskId, "cancelled");
    await vi.advanceTimersByTimeAsync(10);

    expect(runs.getSnapshotForClient(clientKey, timedOutRun.id).report.probes.tasksCancel.status).toBe("pending");

    await vi.advanceTimersByTimeAsync(10);

    expect(runs.getSnapshotForClient(clientKey, timedOutRun.id).report.probes.tasksCancel).toEqual({
      status: "supported_not_completed",
      code: "tasks.cancel",
      message: "Cancellation task timed out before external cancellation was observed.",
    });
    expect(runs.getSnapshotForClient(clientKey, cancelledRun.id).report.probes.tasksCancel.status).toBe("passed");
    store.cleanup();
  });

  it("delegates before binding or observing task creation and status changes", async () => {
    vi.useFakeTimers();
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const { delegate, store } = createStore(runs);
    const beforeCreate = runs.getSnapshotForClient(clientKey, run.id);
    vi.spyOn(delegate, "createTask").mockRejectedValueOnce(new Error("delegate create failed"));

    await expect(
      store.createTask(
        { ttl: null, context: context(clientKey, run.id, "scan") },
        1,
        request(true),
      ),
    ).rejects.toThrow("delegate create failed");
    expect(runs.getSnapshotForClient(clientKey, run.id)).toEqual(beforeCreate);

    const task = await store.createTask(
      { ttl: null, context: context(clientKey, run.id, "task_cancel") },
      2,
      request(true),
    );
    store.armCancellationTimeout(task.taskId, 10);
    vi.spyOn(delegate, "updateTaskStatus").mockRejectedValueOnce(new Error("delegate update failed"));

    await expect(store.updateTaskStatus(task.taskId, "cancelled")).rejects.toThrow("delegate update failed");
    expect(runs.getSnapshotForClient(clientKey, run.id).report.probes.tasksCancel.status).toBe("pending");
    expect(run.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(10);
    expect(runs.getSnapshotForClient(clientKey, run.id).report.probes.tasksCancel.status).toBe(
      "supported_not_completed",
    );
    store.cleanup();
  });

  it("cleanup clears timers, bindings, and a cleanup-capable delegate idempotently", async () => {
    vi.useFakeTimers();
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const { delegate, store } = createStore(runs);
    const task = await store.createTask(
      { ttl: null, context: context(clientKey, run.id, "task_cancel") },
      1,
      request(true),
    );
    store.armCancellationTimeout(task.taskId, 10);

    store.cleanup();
    store.cleanup();
    await vi.advanceTimersByTimeAsync(20);

    expect(store.isTaskAugmented(task.taskId)).toBe(false);
    expect(await delegate.getTask(task.taskId)).toBeNull();
    expect(runs.getSnapshotForClient(clientKey, run.id).report.probes.tasksCancel.status).toBe("pending");
  });

  it("calls non-idempotent delegate cleanup exactly once while local cleanup remains repeatable", async () => {
    vi.useFakeTimers();
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const { delegate, store } = createStore(runs);
    let cleanupCalls = 0;
    const cleanup = vi.fn(() => {
      cleanupCalls += 1;
      if (cleanupCalls > 1) {
        throw new Error("delegate cleanup called more than once");
      }
    });
    delegate.cleanup = cleanup;
    const task = await store.createTask(
      { ttl: null, context: context(clientKey, run.id, "task_cancel") },
      1,
      request(true),
    );
    store.armCancellationTimeout(task.taskId, 10);

    expect(() => {
      store.cleanup();
      store.cleanup();
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(20);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(store.isTaskAugmented(task.taskId)).toBe(false);
    expect(runs.getSnapshotForClient(clientKey, run.id).report.probes.tasksCancel.status).toBe("pending");
  });

  it("ignores malformed and non-capability contexts without mutating a run", async () => {
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const { store } = createStore(runs);
    const before = runs.getSnapshotForClient(clientKey, run.id);

    const tasks = await Promise.all([
      store.createTask({ ttl: null }, 1, request(true)),
      store.createTask(
        { ttl: null, context: { kind: "other", runId: run.id, action: "scan", clientKey } },
        2,
        request(true),
      ),
      store.createTask(
        { ttl: null, context: { kind: "capabilities", runId: 42, action: "scan", clientKey } },
        3,
        request(true),
      ),
      store.createTask(
        { ttl: null, context: { kind: "capabilities", runId: run.id, action: "unknown", clientKey } },
        4,
        request(true),
      ),
      store.createTask(
        { ttl: null, context: { kind: "capabilities", runId: run.id, action: "scan", clientKey: null } },
        5,
        request(true),
      ),
    ]);

    for (const task of tasks) {
      expect(store.isTaskAugmented(task.taskId)).toBe(false);
    }
    expect(runs.getSnapshotForClient(clientKey, run.id)).toEqual(before);
    store.cleanup();
  });

  it("honors process-local client identity and does not expose the client key", async () => {
    const ownerKey = { ownerSecret: "owner-secret" };
    const otherKey = { ownerSecret: "owner-secret" };
    const runs = new CapabilityRunStore();
    const run = createRun(runs, ownerKey);
    const { store } = createStore(runs);

    const wrongClientTask = await store.createTask(
      { ttl: null, context: context(otherKey, run.id, "scan") },
      1,
      request(true),
    );
    store.markPolled(wrongClientTask.taskId);
    expect(store.markResultRequested(wrongClientTask.taskId)).toBeUndefined();

    const unchanged = runs.getSnapshotForClient(ownerKey, run.id).report;
    expect(unchanged.probes.tasksCreate.status).toBe("not_exercised");
    expect(unchanged.probes.tasksPoll.status).toBe("not_exercised");

    const ownerTask = await store.createTask(
      { ttl: null, context: context(ownerKey, run.id, "scan") },
      2,
      request(true),
    );
    store.markPolled(ownerTask.taskId);
    const result = store.markResultRequested(ownerTask.taskId);

    expect(runs.getSnapshotForClient(ownerKey, run.id).report.probes.tasksPoll.status).toBe("passed");
    expect(JSON.stringify(runs.getSnapshotForClient(ownerKey, run.id))).not.toContain("owner-secret");
    expect(JSON.stringify(result)).not.toContain("owner-secret");
    store.cleanup();
  });

  it("ignores missing and expired bound runs during later observations", async () => {
    let nowMs = Date.parse("2026-07-10T00:00:00.000Z");
    const clientKey = {};
    const runs = new CapabilityRunStore({ now: () => new Date(nowMs), ttlMs: 10 });
    const expiredRun = createRun(runs, clientKey);
    const { store } = createStore(runs);
    nowMs += 10;

    const expiredTask = await store.createTask(
      { ttl: null, context: context(clientKey, expiredRun.id, "scan") },
      1,
      request(true),
    );
    const missingTask = await store.createTask(
      { ttl: null, context: context(clientKey, "missing-run", "scan") },
      2,
      request(true),
    );

    expect(() => store.markPolled(expiredTask.taskId)).not.toThrow();
    expect(store.markResultRequested(expiredTask.taskId)).toBeUndefined();
    expect(() => store.markPolled(missingTask.taskId)).not.toThrow();
    expect(store.markResultRequested(missingTask.taskId)).toBeUndefined();
    store.cleanup();
  });

  it("delegates listTasks without changing task evidence", async () => {
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const { store } = createStore(runs);
    const task = await store.createTask(
      { ttl: null, context: context(clientKey, run.id, "scan") },
      1,
      request(false),
    );

    const listed = await store.listTasks();

    expect(listed.tasks.map((item) => item.taskId)).toContain(task.taskId);
    expect(runs.getSnapshotForClient(clientKey, run.id).report.probes.tasksCreate.status).toBe("not_exercised");
    store.cleanup();
  });

  it("propagates unexpected run-store failures instead of swallowing them", async () => {
    const clientKey = {};
    const runs = new CapabilityRunStore();
    const run = createRun(runs, clientKey);
    const { store } = createStore(runs);
    const task = await store.createTask(
      { ttl: null, context: context(clientKey, run.id, "scan") },
      1,
      request(true),
    );
    const failure = new Error("unexpected replacement failure");
    vi.spyOn(runs, "replaceProbe").mockImplementation(() => {
      throw failure;
    });

    expect(() => store.markPolled(task.taskId)).toThrow(failure);
    store.cleanup();
  });
});
