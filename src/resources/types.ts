import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResourceLink } from "@modelcontextprotocol/sdk/types.js";

/** One independently registerable MCP resource family. */
export interface ResourceProvider {
  readonly id: string;
  register(server: McpServer): Promise<void>;
  resolveLink?(uri: string): Promise<ResourceLink | undefined>;
}
