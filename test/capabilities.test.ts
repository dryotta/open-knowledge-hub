import { readFile, rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CreateTaskOptions } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  CallToolResultSchema,
  type CallToolResult,
  type ClientCapabilities,
  type Request,
  type RequestId,
  type Task,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import type { Gh } from "../src/git/gh.js";
import {
  CAPABILITIES_APP_URI,
  type CapabilityRegistrationTimeouts,
} from "../src/server/capabilities.js";
import {
  formatCapabilityReport,
  type CapabilityReport,
} from "../src/server/capabilityReport.js";
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_MIME_TYPE,
} from "../src/server/capabilityProbes.js";
import { CapabilityRunStore } from "../src/server/capabilityRuns.js";
import { buildServer, type BuildServerOptions } from "../src/server/index.js";
import { describeShape, loadToolMeta } from "../src/server/toolMeta.js";
import { toolShapes } from "../src/server/toolSchemas.js";
import { makePaths, makeTempDir, testRun } from "./helpers.js";

const RUN_ID = "0123456789abcdef0123456789abcdef";
const OTHER_RUN_ID = "fedcba9876543210fedcba9876543210";

const servers: McpServer[] = [];
const clients: Client[] = [];
const homes: string[] = [];

class FakeGh {
  async createRepo(): Promise<string> {
    return "x";
  }

  async createPr(): Promise<string> {
    return "x";
  }
}

class RecordingTaskStore extends InMemoryTaskStore {
  readonly createOptions: CreateTaskOptions[] = [];
  cleanupCalls = 0;

  override createTask(
    options: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    sessionId?: string,
  ): Promise<Task> {
    this.createOptions.push(options);
    return super.createTask(options, requestId, request, sessionId);
  }

  override cleanup(): void {
    this.cleanupCalls += 1;
    super.cleanup();
  }
}

class FailingCleanupTaskStore extends RecordingTaskStore {
  override cleanup(): void {
    super.cleanup();
    throw new Error("injected cleanup failure");
  }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

type ConnectOptions = {
  capabilities?: ClientCapabilities;
  build?: Omit<BuildServerOptions, "paths" | "service">;
  clientName?: string;
};

async function connect(options: ConnectOptions = {}): Promise<{
  client: Client;
  server: McpServer;
}> {
  const home = await makeTempDir();
  homes.push(home);
  const paths = makePaths(home);
  const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
  const server = await buildServer({
    paths,
    service,
    capabilityRunId: () => RUN_ID,
    capabilityTimeouts: {
      machineMs: 25,
      samplingMs: 25,
      elicitationMs: 25,
      cancellationTtlMs: 25,
      taskPollIntervalMs: 5,
    },
    ...options.build,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: options.clientName ?? "capability-test-client", version: "1" },
    { capabilities: options.capabilities ?? {} },
  );
  servers.push(server);
  clients.push(client);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function resultOf(result: Awaited<ReturnType<Client["callTool"]>>): CallToolResult {
  return result as CallToolResult;
}

function reportOf(result: Awaited<ReturnType<Client["callTool"]>>): CapabilityReport {
  return resultOf(result).structuredContent as CapabilityReport;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return resultOf(result).content
    .filter((item): item is Extract<CallToolResult["content"][number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function isErrorResult(result: Awaited<ReturnType<Client["callTool"]>>): boolean {
  return resultOf(result).isError === true;
}

async function taskAugmentedScan(client: Client): Promise<CallToolResult> {
  const stream = client.experimental.tasks.callToolStream(
    { name: "capabilities", arguments: {} },
    CallToolResultSchema,
    { task: {} },
  );
  let final: CallToolResult | undefined;
  for await (const message of stream) {
    if (message.type === "error") throw message.error;
    if (message.type === "result") final = message.result as CallToolResult;
  }
  if (final === undefined) throw new Error("Task-augmented scan produced no result.");
  return final;
}

function appCapabilities(): ClientCapabilities {
  return {
    extensions: {
      [MCP_APPS_EXTENSION_ID]: {
        mimeTypes: [MCP_APPS_MIME_TYPE],
      },
    },
  };
}

describe("capabilities registration", () => {
  it("lists optional task metadata and both MCP App resource links", async () => {
    const { client } = await connect();

    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "capabilities");

    expect(tool).toMatchObject({
      name: "capabilities",
      title: "Test MCP client capabilities",
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
    });
    expect(tool?.description).toContain("Actively test roots, sampling, elicitation, MCP Apps, and legacy Tasks");
  });

  it("lists and reads the packaged MCP App resource", async () => {
    const { client } = await connect({ capabilities: appCapabilities() });

    const listed = await client.listResources();
    expect(listed.resources).toContainEqual({
      uri: CAPABILITIES_APP_URI,
      name: "MCP Client Capabilities",
      title: "MCP Client Capabilities",
      mimeType: MCP_APPS_MIME_TYPE,
      _meta: { ui: { prefersBorder: true } },
    });

    const read = await client.readResource({ uri: CAPABILITIES_APP_URI });
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0]).toMatchObject({
      uri: CAPABILITIES_APP_URI,
      mimeType: MCP_APPS_MIME_TYPE,
      _meta: { ui: { prefersBorder: true } },
    });
    const html = "text" in read.contents[0]! ? read.contents[0].text : "";
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("ui/initialize");
    expect(html).toContain("ui/notifications/initialized");
    expect(html).toContain("ui/notifications/size-changed");
    expect(html).toContain("ui/notifications/tool-result");
    expect(html).toContain('"tools/call"');
    expect(html).toContain("app_report");
    expect(html).toContain("event.source");
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("keeps metadata keys, schema keys, strict App input, and packaged resources aligned", async () => {
    const meta = await loadToolMeta("capabilities");
    expect(Object.keys(toolShapes.capabilities)).toEqual(["action", "runId", "app"]);
    expect(Object.keys(meta.args)).toEqual(["action", "runId", "app"]);
    expect(() => describeShape(toolShapes.capabilities, meta.args)).not.toThrow();

    const schema = z.object(toolShapes.capabilities);
    expect(schema.safeParse({
      action: "app_report",
      runId: RUN_ID,
      app: {
        initialized: true,
        theme: "provided",
        resize: "observed",
        payload: "must-not-be-accepted",
      },
    }).success).toBe(false);

    const html = await readFile(new URL("../resources/apps/capabilities.html", import.meta.url), "utf8");
    const markdown = await readFile(new URL("../resources/tool-meta/capabilities.md", import.meta.url), "utf8");
    expect(html).toContain("ui/initialize");
    expect(html).toContain("app_report");
    expect(markdown).toContain("title: Test MCP client capabilities");
  });
});

describe("capabilities actions", () => {
  it("returns equivalent terminal and structured reports with unsupported optional capabilities", async () => {
    const { client } = await connect();

    const result = await client.callTool({ name: "capabilities", arguments: {} });
    const report = reportOf(result);

    expect(report.runId).toBe(RUN_ID);
    expect(report.overallStatus).toBe("complete");
    for (const key of [
      "roots",
      "samplingBasic",
      "samplingTools",
      "elicitationForm",
      "elicitationUrl",
      "appInitialize",
      "appTheme",
      "appResize",
    ] as const) {
      expect(report.probes[key].status).toBe("unsupported");
    }
    for (const key of [
      "tasksCreate",
      "tasksPoll",
      "tasksInput",
      "tasksResult",
      "tasksCancel",
    ] as const) {
      expect(report.probes[key].status).toBe("not_exercised");
    }
    expect(textOf(result)).toBe(formatCapabilityReport(report));
  });

  it("uses the injected run ID and returns an unchanged report for the same client", async () => {
    const { client } = await connect();
    const scanResult = await client.callTool({ name: "capabilities", arguments: {} });
    const scan = reportOf(scanResult);

    const reportResult = await client.callTool({
      name: "capabilities",
      arguments: { action: "report", runId: scan.runId },
    });

    expect(scan.runId).toBe(RUN_ID);
    expect(reportOf(reportResult)).toEqual(scan);
    expect(textOf(reportResult)).toBe(textOf(scanResult));
  });

  it.each([
    [{ action: "report" }, "report requires runId."],
    [{ action: "task_cancel" }, "task_cancel requires runId."],
    [{ action: "app_report" }, "app_report requires runId."],
    [{ action: "scan", runId: RUN_ID }, "scan does not accept runId or app."],
    [{
      action: "scan",
      app: { initialized: true, theme: "provided", resize: "observed" },
    }, "scan does not accept runId or app."],
    [{ action: "app_report", runId: RUN_ID }, "app_report requires app."],
    [{
      action: "report",
      runId: RUN_ID,
      app: { initialized: true, theme: "provided", resize: "observed" },
    }, "report does not accept app."],
    [{
      action: "task_cancel",
      runId: RUN_ID,
      app: { initialized: true, theme: "provided", resize: "observed" },
    }, "task_cancel does not accept app."],
  ])("rejects invalid action arguments without reflecting input: %j", async (argumentsValue, message) => {
    const { client } = await connect();

    const result = await client.callTool({ name: "capabilities", arguments: argumentsValue });

    expect(isErrorResult(result)).toBe(true);
    expect(textOf(result)).toBe(`MCP error ${ErrorCode.InvalidParams}: ${message}`);
    expect(JSON.stringify(result)).not.toContain("capability-test-client");
  });

  it("replaces only App probes with normalized fixed observations", async () => {
    const { client } = await connect({ capabilities: appCapabilities() });
    const scan = reportOf(await client.callTool({ name: "capabilities", arguments: {} }));

    const observed = reportOf(await client.callTool({
      name: "capabilities",
      arguments: {
        action: "app_report",
        runId: scan.runId,
        app: { initialized: true, theme: "provided", resize: "observed" },
      },
    }));

    expect(observed.probes.appInitialize).toEqual({
      status: "passed",
      code: "apps.initialize",
      message: "MCP App initialized and called the server.",
    });
    expect(observed.probes.appTheme).toEqual({
      status: "passed",
      code: "apps.theme",
      message: "Host supplied theme context.",
    });
    expect(observed.probes.appResize).toEqual({
      status: "passed",
      code: "apps.resize",
      message: "Host container dimensions changed.",
    });
    expect(observed.probes.roots).toEqual(scan.probes.roots);
    expect(observed.probes.tasksCancel).toEqual(scan.probes.tasksCancel);
    expect(observed.client).toEqual(scan.client);
    expect({
      runId: observed.runId,
      createdAt: observed.createdAt,
      expiresAt: observed.expiresAt,
    }).toEqual({
      runId: scan.runId,
      createdAt: scan.createdAt,
      expiresAt: scan.expiresAt,
    });

    const fixed = reportOf(await client.callTool({
      name: "capabilities",
      arguments: {
        action: "app_report",
        runId: scan.runId,
        app: { initialized: true, theme: "absent", resize: "fixed_container" },
      },
    }));
    expect(fixed.probes.appTheme).toEqual({
      status: "unsupported",
      code: "apps.theme",
      message: "Host supplied no theme context.",
    });
    expect(fixed.probes.appResize).toEqual({
      status: "supported_not_completed",
      code: "apps.resize",
      message: "Host declared a fixed container.",
    });

    const unobserved = reportOf(await client.callTool({
      name: "capabilities",
      arguments: {
        action: "app_report",
        runId: scan.runId,
        app: { initialized: true, theme: "absent", resize: "unobserved" },
      },
    }));
    expect(unobserved.probes.appResize).toEqual({
      status: "failed",
      code: "apps.resize",
      message: "No resize outcome was observable.",
    });
  });

  it("rejects malformed App observations without retaining arbitrary payload", async () => {
    const { client } = await connect({ capabilities: appCapabilities() });
    const scan = reportOf(await client.callTool({ name: "capabilities", arguments: {} }));
    const hostileField = "arbitrary-app-field-must-not-appear";
    const hostilePayload = "arbitrary-app-payload-must-not-appear";

    const malformed = await client.callTool({
      name: "capabilities",
      arguments: {
        action: "app_report",
        runId: scan.runId,
        app: {
          initialized: true,
          theme: "provided",
          resize: "observed",
          [hostileField]: hostilePayload,
        },
      },
    });

    expect(isErrorResult(malformed)).toBe(true);
    expect(JSON.stringify(malformed)).not.toContain(hostileField);
    expect(JSON.stringify(malformed)).not.toContain(hostilePayload);
    const current = reportOf(await client.callTool({
      name: "capabilities",
      arguments: { action: "report", runId: scan.runId },
    }));
    expect(current.probes.appInitialize.status).toBe("pending");
    expect(JSON.stringify(current)).not.toContain(hostilePayload);
  });

  it("rejects a follow-up from a different server connection sharing the run store", async () => {
    const runs = new CapabilityRunStore({ createId: () => RUN_ID });
    const owner = await connect({
      clientName: "private-owner-client",
      build: { capabilityRuns: runs },
    });
    const other = await connect({
      clientName: "private-other-client",
      build: { capabilityRuns: runs, capabilityRunId: () => OTHER_RUN_ID },
    });
    const scan = reportOf(await owner.client.callTool({ name: "capabilities", arguments: {} }));

    const rejected = await other.client.callTool({
      name: "capabilities",
      arguments: { action: "report", runId: scan.runId },
    });

    expect(isErrorResult(rejected)).toBe(true);
    expect(textOf(rejected)).toBe(
      `MCP error ${ErrorCode.InvalidParams}: Capability run is not accessible from this client.`,
    );
    expect(JSON.stringify(rejected)).not.toContain("private-owner-client");
    expect(JSON.stringify(rejected)).not.toContain("private-other-client");
  });

  it("keeps cancellation not exercised without task augmentation and supports report fallback", async () => {
    const { client } = await connect();
    const scan = reportOf(await client.callTool({ name: "capabilities", arguments: {} }));

    const cancellation = reportOf(await client.callTool({
      name: "capabilities",
      arguments: { action: "task_cancel", runId: scan.runId },
    }));
    const fallback = reportOf(await client.callTool({
      name: "capabilities",
      arguments: { action: "report", runId: scan.runId },
    }));

    expect(cancellation.probes.tasksCancel).toEqual({
      status: "not_exercised",
      code: "tasks.cancel",
      message: "Task cancellation requires a task-augmented call.",
    });
    expect(fallback).toEqual(cancellation);
  });

  it("records create, poll, and result task probes as passed for a task-augmented scan", async () => {
    const { client } = await connect();

    const result = await taskAugmentedScan(client);
    const report = result.structuredContent as CapabilityReport;

    expect(report.runId).toBe(RUN_ID);
    expect(report.probes.tasksCreate.status).toBe("passed");
    expect(report.probes.tasksPoll.status).toBe("passed");
    expect(report.probes.tasksResult.status).toBe("passed");
    expect(report.probes.tasksInput.status).toBe("not_exercised");
    expect(report.probes.tasksCancel.status).toBe("not_exercised");
    expect(textOf(result)).toBe(formatCapabilityReport(report));
  });

  it("rejects app_report when MCP Apps are not advertised without reflecting input", async () => {
    const { client } = await connect();
    const scan = reportOf(await client.callTool({ name: "capabilities", arguments: {} }));
    expect(scan.probes.appInitialize.status).toBe("unsupported");

    const rejected = await client.callTool({
      name: "capabilities",
      arguments: {
        action: "app_report",
        runId: scan.runId,
        app: { initialized: true, theme: "provided", resize: "observed" },
      },
    });

    expect(isErrorResult(rejected)).toBe(true);
    expect(textOf(rejected)).toBe(
      `MCP error ${ErrorCode.InvalidParams}: MCP App reporting is not available for this run.`,
    );
    expect(JSON.stringify(rejected)).not.toContain("capability-test-client");

    const after = reportOf(await client.callTool({
      name: "capabilities",
      arguments: { action: "report", runId: scan.runId },
    }));
    expect(after.probes.appInitialize.status).toBe("unsupported");
  });

  it("returns the SDK not-found error for a tasks/get poll of an unknown task", async () => {
    const { client } = await connect();

    await expect(client.experimental.tasks.getTask("does-not-exist")).rejects.toThrow(
      "Failed to retrieve task: Task not found",
    );
  });
});

describe("capabilities dependency wiring", () => {
  it("uses injected stores, strips the private client key, and applies injected task timing", async () => {
    const taskStore = new RecordingTaskStore();
    const runs = new CapabilityRunStore({ createId: () => OTHER_RUN_ID });
    const timeouts: Partial<CapabilityRegistrationTimeouts> = {
      taskPollIntervalMs: 3,
    };
    const { client } = await connect({
      build: {
        taskStore,
        taskMessageQueue: new InMemoryTaskMessageQueue(),
        capabilityRuns: runs,
        capabilityRunId: () => RUN_ID,
        capabilityTimeouts: timeouts,
      },
    });

    const report = reportOf(await client.callTool({ name: "capabilities", arguments: {} }));

    expect(report.runId).toBe(OTHER_RUN_ID);
    expect(taskStore.createOptions).toHaveLength(1);
    expect(taskStore.createOptions[0]).toEqual({
      ttl: 30 * 60_000,
      pollInterval: 3,
      context: {
        kind: "capabilities",
        runId: OTHER_RUN_ID,
        action: "scan",
      },
    });
    expect(JSON.stringify(taskStore.createOptions[0])).not.toContain("clientKey");
  });

  it("cleans an injected task store and run store when an unconnected server closes", async () => {
    const home = await makeTempDir();
    homes.push(home);
    const paths = makePaths(home);
    const taskStore = new RecordingTaskStore();
    const runs = new CapabilityRunStore();
    const dispose = vi.spyOn(runs, "dispose");
    const server = await buildServer({
      paths,
      service: new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh),
      taskStore,
      capabilityRuns: runs,
    });
    servers.push(server);

    await server.close();
    await server.close();

    expect(taskStore.cleanupCalls).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("cleans injected stores when the connected peer closes the transport", async () => {
    const taskStore = new RecordingTaskStore();
    const runs = new CapabilityRunStore();
    const dispose = vi.spyOn(runs, "dispose");
    const { client } = await connect({
      build: {
        taskStore,
        capabilityRuns: runs,
      },
    });

    await client.close();

    expect(taskStore.cleanupCalls).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes runs even when injected task-store cleanup fails", async () => {
    const home = await makeTempDir();
    homes.push(home);
    const paths = makePaths(home);
    const taskStore = new FailingCleanupTaskStore();
    const runs = new CapabilityRunStore();
    const dispose = vi.spyOn(runs, "dispose");
    const server = await buildServer({
      paths,
      service: new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh),
      taskStore,
      capabilityRuns: runs,
    });
    servers.push(server);

    await expect(server.close()).rejects.toThrow("injected cleanup failure");

    expect(taskStore.cleanupCalls).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
