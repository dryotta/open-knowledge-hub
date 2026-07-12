import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolvePaths, type OkhPaths } from "../config.js";
import { ContainerService } from "../container/service.js";
import { loadPreferencesSync } from "../preferences.js";
import { buildInstructions } from "../prompts/index.js";
import { TodoService } from "../todos/service.js";
import { registerTools } from "./tools.js";

export interface BuildServerOptions {
  paths?: OkhPaths;
  service?: ContainerService;
  todoService?: TodoService;
  capabilityProbeTimeoutMs?: number;
  todoWebUrl?: string;
}

/** Construct the fully-wired MCP server. Dependencies are injectable for tests. */
export async function buildServer(options: BuildServerOptions = {}): Promise<McpServer> {
  const paths = options.paths ?? resolvePaths();
  const service = options.service ?? new ContainerService(paths);
  const todoService = options.todoService ?? new TodoService(service);
  const prefs = loadPreferencesSync(paths);
  const server = new McpServer(
    { name: "open-knowledge-hub", version: "0.2.0" },
    { instructions: await buildInstructions(prefs as unknown as Record<string, unknown>) },
  );
  await registerTools(
    server,
    service,
    paths,
    todoService,
    {
      ...(options.capabilityProbeTimeoutMs !== undefined ? { capabilityProbeTimeoutMs: options.capabilityProbeTimeoutMs } : {}),
      ...(options.todoWebUrl !== undefined ? { todoWebUrl: options.todoWebUrl } : {}),
    },
  );
  return server;
}
