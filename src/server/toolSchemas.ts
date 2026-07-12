import { z } from "zod";

const container = z.string().optional();
const moduleArg = z.string().optional();
const todoPriority = z.enum(["lowest", "low", "normal", "medium", "high", "highest"]);

const syncSelection = z.object({
  mode: z.enum(["auto", "shared"]),
  config: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** Bare Zod arg shapes for every tool; descriptions come from resources/tool-meta/<name>.md. */
export const toolShapes = {
  inspect: { container, module: moduleArg },
  add_container: {
    source: z.string(),
    name: z.string().optional(),
    sync: syncSelection.optional(),
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
  sync: { container, message: z.string().optional(), action: z.string().min(1).optional() },
  config: { set: z.record(z.string(), z.unknown()).optional() },
  onboard: {},
  ask: { container, module: moduleArg, question: z.string().optional() },
  capabilities: {},
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
};

export type ToolName = keyof typeof toolShapes;
