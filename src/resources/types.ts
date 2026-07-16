import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** One independently registerable MCP resource family. */
export interface ResourceProvider {
  readonly id: string;
  register(server: McpServer): Promise<void>;
}
