import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolvePaths, type OkhPaths } from "../config.js";
import { ContainerService } from "../container/service.js";
import { registerPrompts } from "./prompts.js";
import { registerTools } from "./tools.js";

export interface BuildServerOptions {
  paths?: OkhPaths;
  service?: ContainerService;
}

/** Construct the fully-wired MCP server. Dependencies are injectable for tests. */
export function buildServer(options: BuildServerOptions = {}): McpServer {
  const paths = options.paths ?? resolvePaths();
  const service = options.service ?? new ContainerService(paths);
  const server = new McpServer(
    { name: "open-knowledge-hub", version: "0.2.0" },
    {
      instructions:
        "Open Knowledge Hub: organizes agent knowledge and capabilities into containers of typed modules " +
        "(knowledge, skills, tools, memory, project). Use inspect/add/sync to manage containers; use " +
        "ask/context/learn/remember/reflect (prompts or tools) to think with them. Writes are synced via git " +
        "(commit+push, or pull requests).",
    },
  );
  registerTools(server, service);
  registerPrompts(server, service);
  return server;
}
