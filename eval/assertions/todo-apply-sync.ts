import type { ToolEvent } from "../copilot.js";
import { checkTodoApplySync } from "./checks.js";

interface Ctx {
  config?: { operation?: "create" | "update"; container?: string };
  providerResponse?: { metadata?: { toolEvents?: ToolEvent[] } };
}

export default async function todoApplySync(_output: string, context: Ctx) {
  const operation = context.config?.operation;
  if (operation !== "create" && operation !== "update") {
    return { pass: false, score: 0, reason: 'config.operation must be "create" or "update"' };
  }
  const result = await checkTodoApplySync(
    { transcript: "", toolEvents: context.providerResponse?.metadata?.toolEvents ?? [] },
    operation,
    context.config?.container,
  );
  return { ...result, score: result.pass ? 1 : 0 };
}
