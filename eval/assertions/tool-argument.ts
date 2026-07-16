import type { ToolEvent } from "../copilot.js";
import { matchesTool } from "./tool-events.js";

interface Ctx {
  config?: {
    tool?: string;
    server?: string;
    turn?: number;
    argument?: string;
    mustContain?: string[];
    mustNotContain?: string[];
  };
  providerResponse?: { metadata?: { toolEvents?: ToolEvent[] } };
}

/** Pass iff a successful tool call has a string argument within the configured regex boundaries. */
export default function toolArgument(_output: string, context: Ctx) {
  const config = context.config;
  if (!config?.tool || !config.argument) {
    return { pass: false, score: 0, reason: "tool and argument are required" };
  }

  const event = (context.providerResponse?.metadata?.toolEvents ?? []).find((candidate) =>
    matchesTool(candidate, {
      name: config.tool!,
      ...(config.server === undefined ? {} : { server: config.server }),
      ...(config.turn === undefined ? {} : { turn: config.turn }),
    }),
  );
  if (!event) {
    return { pass: false, score: 0, reason: `successful ${config.tool} call not found` };
  }

  const args = event.arguments;
  const value = typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)[config.argument]
    : undefined;
  if (typeof value !== "string") {
    return { pass: false, score: 0, reason: `${config.tool}.${config.argument} is not a string` };
  }

  const missing = (config.mustContain ?? []).filter((pattern) => !new RegExp(pattern, "i").test(value));
  const unexpected = (config.mustNotContain ?? []).filter((pattern) => new RegExp(pattern, "i").test(value));
  const pass = missing.length === 0 && unexpected.length === 0;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? `${config.tool}.${config.argument} matched`
      : `missing: [${missing.join(", ")}] unexpected: [${unexpected.join(", ")}]`,
  };
}
