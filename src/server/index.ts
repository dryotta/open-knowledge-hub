import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  TaskMessageQueue,
  TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { resolvePaths, type OkhPaths } from "../config.js";
import { ContainerService } from "../container/service.js";
import { loadPreferencesSync } from "../preferences.js";
import { buildInstructions } from "../prompts/index.js";
import { TodoService } from "../todos/service.js";
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_MIME_TYPE,
} from "./capabilityProbes.js";
import { toCapabilityToolResult } from "./capabilityReport.js";
import { CapabilityRunStore } from "./capabilityRuns.js";
import { CapabilityTaskStore } from "./capabilityTaskStore.js";
import {
  registerCapabilities,
  type CapabilityRegistrationTimeouts,
} from "./capabilities.js";
import { registerTools } from "./tools.js";

export interface BuildServerOptions {
  paths?: OkhPaths;
  service?: ContainerService;
  todoService?: TodoService;
  taskStore?: TaskStore;
  taskMessageQueue?: TaskMessageQueue;
  capabilityRuns?: CapabilityRunStore;
  capabilityTimeouts?: Partial<CapabilityRegistrationTimeouts>;
  capabilityRunId?: () => string;
}

/** Construct the fully-wired MCP server. Dependencies are injectable for tests. */
export async function buildServer(options: BuildServerOptions = {}): Promise<McpServer> {
  const paths = options.paths ?? resolvePaths();
  const service = options.service ?? new ContainerService(paths);
  const todoService = options.todoService ?? new TodoService(service);
  const prefs = loadPreferencesSync(paths);
  const runs = options.capabilityRuns ?? new CapabilityRunStore(
    options.capabilityRunId === undefined
      ? {}
      : { createId: options.capabilityRunId },
  );
  const underlyingTaskStore = options.taskStore ?? new InMemoryTaskStore();
  const observedTaskStore = new CapabilityTaskStore(
    underlyingTaskStore,
    runs,
    (runId, clientKey) =>
      toCapabilityToolResult(
        runs.getSnapshotForClient(clientKey, runId).report,
      ),
  );
  const taskMessageQueue = options.taskMessageQueue ?? new InMemoryTaskMessageQueue();
  const clientKey = {};
  const server = new McpServer(
    { name: "open-knowledge-hub", version: "0.2.0" },
    {
      instructions: await buildInstructions(prefs as unknown as Record<string, unknown>),
      taskStore: observedTaskStore,
      taskMessageQueue,
      defaultTaskPollInterval: 500,
      maxTaskQueueSize: 64,
      capabilities: {
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
        extensions: {
          [MCP_APPS_EXTENSION_ID]: {
            mimeTypes: [MCP_APPS_MIME_TYPE],
          },
        },
      },
    },
  );
  await registerTools(server, service, paths, todoService);
  await registerCapabilities(server, {
    runs,
    tasks: observedTaskStore,
    clientKey,
    ...(options.capabilityTimeouts === undefined
      ? {}
      : { timeouts: options.capabilityTimeouts }),
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      observedTaskStore.cleanup();
    } finally {
      runs.dispose();
    }
  };
  const onclose = server.server.onclose;
  server.server.onclose = () => {
    try {
      onclose?.();
    } finally {
      cleanup();
    }
  };
  const close = server.close.bind(server);
  server.close = async () => {
    try {
      await close();
    } finally {
      cleanup();
    }
  };

  return server;
}
