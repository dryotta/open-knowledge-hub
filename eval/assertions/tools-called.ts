import type { ToolEvent } from "../copilot.js";
import { matchesToolAttempt, type ToolExpectation, missingTools } from "./tool-events.js";

interface Ctx {
  config?: {
    expect?: Array<string | ToolExpectation>;
    forbid?: Array<string | ToolExpectation>;
    ordered?: boolean;
  };
  providerResponse?: { metadata?: { toolCalls?: string[]; toolEvents?: ToolEvent[] } };
}

function describeExpectation(expectation: string | ToolExpectation): string {
  return typeof expectation === "string"
    ? expectation
    : `${expectation.name}${expectation.arguments ? ` ${JSON.stringify(expectation.arguments)}` : ""}`;
}

/** Pass iff expected calls appear and forbidden calls do not. */
export default function toolsCalled(_output: string, context: Ctx) {
  const expected = context.config?.expect ?? [];
  const forbidden = context.config?.forbid ?? [];
  const events = context.providerResponse?.metadata?.toolEvents ?? [];
  const ordered = context.config?.ordered ?? false;

  const missing = missingTools(events, expected, ordered);
  const presentForbidden = forbidden.filter((entry) => {
    const expectation = typeof entry === "string" ? { name: entry } : entry;
    return events.some((event) => matchesToolAttempt(event, expectation));
  });
  const pass = missing.length === 0 && presentForbidden.length === 0;
  const calledNames = (context.providerResponse?.metadata?.toolCalls ?? []).join(", ") || "(none)";
  const missingDesc = missing.map(describeExpectation).join(", ");
  const forbiddenDesc = presentForbidden.map(describeExpectation).join(", ");
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? `tools called: ${calledNames}`
      : [
          missing.length > 0 ? `missing tool calls: ${missingDesc}${ordered ? " (ordered)" : ""}` : "",
          presentForbidden.length > 0 ? `forbidden tool calls: ${forbiddenDesc}` : "",
        ].filter(Boolean).join("; "),
  };
}
