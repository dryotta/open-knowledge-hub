import { z } from "zod";

const container = z.string().optional();
const moduleArg = z.string().optional();
const todoPriority = z.enum(["lowest", "low", "normal", "medium", "high", "highest"]);
const CAPABILITY_APP_ERROR = "Invalid MCP App observations.";
const capabilityThemes = ["provided", "absent"] as const;
const capabilityResizeOutcomes = ["observed", "fixed_container", "unobserved"] as const;

function isCapabilityAppInput(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  return (
    keys.length === 3 &&
    keys[0] === "initialized" &&
    keys[1] === "resize" &&
    keys[2] === "theme" &&
    input.initialized === true &&
    capabilityThemes.includes(input.theme as (typeof capabilityThemes)[number]) &&
    capabilityResizeOutcomes.includes(input.resize as (typeof capabilityResizeOutcomes)[number])
  );
}

// Replace malformed input before strict parsing so validation never reflects App fields.
const capabilityApp = z.preprocess(
  (value) => isCapabilityAppInput(value) ? value : null,
  z.object({
    initialized: z.literal(true),
    theme: z.enum(capabilityThemes),
    resize: z.enum(capabilityResizeOutcomes),
  }, { error: CAPABILITY_APP_ERROR }).strict(),
);

/** Bare Zod arg shapes for every tool; descriptions come from resources/tool-meta/<name>.md. */
export const toolShapes = {
  inspect: { container, module: moduleArg },
  add_container: {
    source: z.string(),
    name: z.string().optional(),
    sync: z.enum(["auto", "pr"]).optional(),
    backend: z.enum(["local", "onedrive"]).optional(),
    create: z.boolean().optional(),
  },
  add_module: {
    container: z.string().optional(),
    path: z.string().optional(),
    type: z.string().min(1).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    create: z.boolean().optional(),
  },
  sync: { container, message: z.string().optional() },
  config: { set: z.record(z.string(), z.unknown()).optional() },
  onboard: {},
  ask: { container, module: moduleArg, question: z.string().optional() },
  context: { container, task: z.string().optional() },
  run: { container, module: moduleArg, skill: z.string(), input: z.string().optional() },
  todos: {
    operation: z.enum(["list", "create", "update"]).optional(),
    container,
    module: moduleArg,
    status: z.enum(["open", "completed", "custom", "all"]).optional(),
    labels: z.array(z.string()).optional(),
    labelMode: z.enum(["any", "all"]).optional(),
    priorities: z.array(todoPriority).optional(),
    dueAfter: z.string().optional(),
    dueBefore: z.string().optional(),
    overdue: z.boolean().optional(),
    query: z.string().optional(),
    text: z.string().optional(),
    entrySummary: z.string().optional(),
    observation: z.string().optional(),
    ref: z.string().optional(),
    completed: z.boolean().optional(),
    due: z.string().nullable().optional(),
    priority: todoPriority.nullable().optional(),
    apply: z.boolean().optional(),
  },
  capabilities: {
    action: z.enum(["scan", "app_report", "task_cancel", "report"]).optional(),
    runId: z.string().min(16).optional(),
    app: capabilityApp.optional(),
  },
};

export type ToolName = keyof typeof toolShapes;
