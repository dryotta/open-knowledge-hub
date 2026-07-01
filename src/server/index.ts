import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolvePaths, type OkhPaths } from "../config.js";
import { PackService } from "../packs/service.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";

export interface BuildServerOptions {
  paths?: OkhPaths;
  service?: PackService;
}

/**
 * Construct the fully-wired MCP server (tools + prompts). Dependencies are
 * injectable for testing; by default it resolves paths from the environment.
 */
export function buildServer(options: BuildServerOptions = {}): McpServer {
  const paths = options.paths ?? resolvePaths();
  const service = options.service ?? new PackService(paths);

  const server = new McpServer(
    { name: "open-knowledge-hub", version: "0.1.0" },
    {
      instructions:
        "Manages a personal catalog of OKF knowledge packs, each backed by a git repo. " +
        "Use catalog_/pack_ tools to install and manage packs; use the ask/learn/review_update/create " +
        "flows (prompts or tools) to work with a pack's knowledge. Edits are published as pull requests.",
    },
  );

  registerTools(server, service);
  registerPrompts(server, service);
  return server;
}
