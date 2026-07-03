import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";

/** Construct the MCP server. Full wiring is added in Tasks 13-14. */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "open-knowledge-hub", version: "0.2.0" },
    {
      instructions:
        "Open Knowledge Hub: organizes agent knowledge and capabilities into containers of typed modules. " +
        "Use inspect/add/sync to manage containers; use ask/context/learn/remember/reflect to think with them.",
    },
  );
  registerTools(server);
  registerPrompts(server);
  return server;
}
