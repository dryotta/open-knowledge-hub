import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ReadResourceResult,
  ResourceLink,
} from "@modelcontextprotocol/sdk/types.js";

export interface ResourceReadOptions {
  /** Reject the read if its returned content would exceed this byte budget. */
  maxBytes?: number;
}

/** One independently registerable MCP resource family. */
export interface ResourceProvider {
  readonly id: string;
  register(server: McpServer): Promise<void>;
  read(
    uri: string,
    options?: ResourceReadOptions,
  ): Promise<ReadResourceResult | undefined>;
  resolveLink?(uri: string): Promise<ResourceLink | undefined>;
}
