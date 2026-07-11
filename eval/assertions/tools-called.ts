import type { ToolEvent } from "../copilot.js";
import { type ToolExpectation, missingTools } from "./tool-events.js";

interface Ctx {
  config?: { expect?: Array<string | ToolExpectation>; ordered?: boolean };
  providerResponse?: { metadata?: { toolCalls?: string[]; toolEvents?: ToolEvent[] } };
}

/** Pass iff every expected OKH tool appears in the run's detected tool calls. */
export default function toolsCalled(_output: string, context: Ctx) {
  const expected = context.config?.expect ?? [];
  const events = context.providerResponse?.metadata?.toolEvents ?? [];
  const ordered = context.config?.ordered ?? false;

  const missing = missingTools(events, expected, ordered);
  const pass = missing.length === 0;
  const calledNames = (context.providerResponse?.metadata?.toolCalls ?? []).join(", ") || "(none)";
  const missingDesc = missing
    .map((m) => (typeof m === "string" ? m : `${m.name}${m.arguments ? ` ${JSON.stringify(m.arguments)}` : ""}`))
    .join(", ");
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? `tools called: ${calledNames}`
      : `missing tool calls: ${missingDesc}${ordered ? " (ordered)" : ""}`,
  };
}
