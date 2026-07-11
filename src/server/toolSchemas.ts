import { z } from "zod";

const container = z.string().optional();
const moduleArg = z.string().optional();
const todoPriority = z.enum(["lowest", "low", "normal", "medium", "high", "highest"]);

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
  },
  update_todo: {
    operation: z.enum(["create", "patch"]),
    container: z.string().optional(),
    module: z.string().optional(),
    text: z.string().optional(),
    entrySummary: z.string().optional(),
    observation: z.string().optional(),
    ref: z.string().optional(),
    completed: z.boolean().optional(),
    labels: z.array(z.string()).optional(),
    due: z.string().nullable().optional(),
    priority: todoPriority.nullable().optional(),
  },
};

export type ToolName = keyof typeof toolShapes;
