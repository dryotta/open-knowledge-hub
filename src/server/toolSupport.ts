import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isOkhError } from "../errors.js";
import type { RenderContext } from "../prompts/templates.js";
import { describeShape, loadToolMeta } from "./toolMeta.js";
import { toolShapes, type ToolName } from "./toolSchemas.js";

export async function toolReg<N extends ToolName>(name: N, ctx?: RenderContext) {
  const m = await loadToolMeta(name, ctx);
  return { title: m.title, description: m.description, inputSchema: describeShape(toolShapes[name], m.args) };
}

export function ok(text: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}

export function fail(message: string, hint?: string): CallToolResult {
  return { content: [{ type: "text", text: hint ? `${message}\n\nHint: ${hint}` : message }], isError: true };
}

export function handler<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      if (isOkhError(err)) return fail(`[${err.code}] ${err.message}`, err.hint);
      throw err;
    }
  };
}

export function isBlank(value: string): boolean {
  return value.trim().length === 0;
}
