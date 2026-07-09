import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolvePaths, type OkhPaths } from "../config.js";
import { ContainerService } from "../container/service.js";
import { loadPreferencesSync } from "../preferences.js";
import { buildInstructions } from "../prompts/index.js";
import { registerTools } from "./tools.js";

export interface BuildServerOptions {
  paths?: OkhPaths;
  service?: ContainerService;
}

/** Construct the fully-wired MCP server. Dependencies are injectable for tests. */
export async function buildServer(options: BuildServerOptions = {}): Promise<McpServer> {
  const paths = options.paths ?? resolvePaths();
  const service = options.service ?? new ContainerService(paths);
  const prefs = loadPreferencesSync(paths);
  const server = new McpServer(
    { name: "open-knowledge-hub", version: "0.2.0" },
    { instructions: await buildInstructions(prefs as unknown as Record<string, unknown>) },
  );
  registerTools(server, service, paths);
  return server;
}
