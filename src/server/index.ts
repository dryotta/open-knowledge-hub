import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolvePaths, type OkhPaths } from "../config.js";
import { ContainerService } from "../container/service.js";
import { loadPreferencesSync } from "../preferences.js";
import { buildInstructions } from "../prompts/index.js";
import { TodoService } from "../todos/service.js";
import { registerResources } from "../resources/index.js";
import { registerTools } from "./tools.js";
import { WorkspaceService } from "../workspaces/service.js";

export interface BuildServerOptions {
  paths?: OkhPaths;
  service?: ContainerService;
  todoService?: TodoService;
  workspaceService?: WorkspaceService;
  capabilityProbeTimeoutMs?: number;
  todoWebUrl?: string;
}

/** Construct the fully-wired MCP server. Dependencies are injectable for tests. */
export async function buildServer(options: BuildServerOptions = {}): Promise<McpServer> {
  const paths = options.paths ?? resolvePaths();
  const service = options.service ?? new ContainerService(paths);
  const todoService = options.todoService ?? new TodoService(service);
  const workspaceService = options.workspaceService ?? new WorkspaceService(service, paths);
  const prefs = loadPreferencesSync(paths);
  const server = new McpServer(
    { name: "open-knowledge-hub", version: "0.2.0" },
    { instructions: await buildInstructions(prefs as unknown as Record<string, unknown>) },
  );
  const resources = await registerResources(server, service);
  await registerTools(
    server,
    service,
    paths,
    todoService,
    workspaceService,
    resources,
    {
      ...(options.capabilityProbeTimeoutMs !== undefined ? { capabilityProbeTimeoutMs: options.capabilityProbeTimeoutMs } : {}),
      ...(options.todoWebUrl !== undefined ? { todoWebUrl: options.todoWebUrl } : {}),
    },
  );
  return server;
}
