import { z } from "zod";

const container = z.string().optional();
const moduleArg = z.string().optional();

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
    container: z.string(),
    path: z.string(),
    type: z.string().min(1),
    name: z.string(),
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
};

export type ToolName = keyof typeof toolShapes;
