import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolvePaths, type OkhPaths } from "../config.js";
import { ContainerService } from "../container/service.js";
import { loadPreferencesSync } from "../preferences.js";
import { registerPrompts } from "./prompts.js";
import { registerTools } from "./tools.js";

export interface BuildServerOptions {
  paths?: OkhPaths;
  service?: ContainerService;
}

function buildInstructions(wakePhrase: string): string {
  return (
    "Open Knowledge Hub: organizes agent knowledge and capabilities into containers of typed modules " +
    "(knowledge, skills, tools, memory, project). Use inspect/add/sync to manage containers and config to " +
    "view or change settings; use ask/context/learn/remember/reflect (prompts or tools) to think with them. " +
    "Start with the onboard prompt/tool for first-run setup. `add` previews changes and needs create:true to " +
    "apply after user confirmation. " +
    `You can address this hub as "${wakePhrase}": when a message begins with "${wakePhrase}" or mentions ` +
    '"the hub" / "knowledge hub", use these tools. Writes are synced via git (commit+push, or pull requests).'
  );
}

/** Construct the fully-wired MCP server. Dependencies are injectable for tests. */
export function buildServer(options: BuildServerOptions = {}): McpServer {
  const paths = options.paths ?? resolvePaths();
  const service = options.service ?? new ContainerService(paths);
  const { wakePhrase } = loadPreferencesSync(paths);
  const server = new McpServer(
    { name: "open-knowledge-hub", version: "0.2.0" },
    { instructions: buildInstructions(wakePhrase) },
  );
  registerTools(server, service, paths);
  registerPrompts(server, service, paths);
  return server;
}
