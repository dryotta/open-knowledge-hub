import { z } from "zod";

/**
 * Single source of truth for the flows (`ask`, `context`, `onboard`, `run`).
 * Each flow is exposed as a tool. Flows never act on their own — they return
 * discipline/instructions for the client agent to follow. `run` resolves a
 * module skill (container+module) or, with neither, a module-less shared skill.
 */

export type FlowName = "ask" | "context" | "onboard" | "run";

/** Argument descriptions, shared so the prompt-tools and prompts stay in lockstep. */
export const argDescriptions = {
  container: "Container name (default: all registered containers).",
  module: "Module path within the container.",
  question: "The question to answer.",
  task: "The task to prepare for.",
} as const;

const container = z.string().optional().describe(argDescriptions.container);
const moduleArg = z.string().optional().describe(argDescriptions.module);

/** Argument shapes per flow, used as both `inputSchema` (tools) and `argsSchema` (prompts). */
export const flowArgShapes = {
  ask: { container, module: moduleArg, question: z.string().optional().describe(argDescriptions.question) },
  context: { container, task: z.string().optional().describe(argDescriptions.task) },
  onboard: {},
  run: {
    container: z.string().optional().describe("Container name. Provide with module to run a module skill; omit both to run a shared skill."),
    module: z.string().optional().describe("Module path within the container. Provide with container; omit both to run a shared skill."),
    skill: z.string().describe("Skill name to run: a module skill (with container+module) or a shared skill (see the referencing skill, e.g. grilling, okf-writer)."),
    input: z.string().optional().describe("Freeform payload passed to the skill (e.g. the knowledge to learn, the observation to remember)."),
  },
} as const;

export interface FlowMeta {
  /** Title for both the prompt-tool and the prompt. Contains the flow name as a word for transcript detection. */
  title: string;
  /** Description used verbatim for both the prompt-tool and the prompt. */
  description: string;
}

/**
 * Titles and descriptions for each flow. Every description makes explicit that a
 * flow returns *instructions* (discipline) and does not perform the work itself —
 * the client agent does the reading, reasoning, and any writing.
 */
export const flowMeta: Record<FlowName, FlowMeta> = {
  ask: {
    title: "Ask (flow)",
    description:
      "Return discipline that guides the agent to answer a question from your containers' modules. " +
      "Guidance only: this returns instructions, it does not answer the question itself.",
  },
  context: {
    title: "Context (flow)",
    description:
      "Return discipline that guides the agent to assemble a task-relevant working set across your containers. " +
      "Guidance only: this returns instructions, it does not assemble the working set itself.",
  },
  onboard: {
    title: "Onboard (guided setup)",
    description:
      "Return multi-turn onboarding guidance for a first-run user: intro and terminology (hub = the system; " +
      "container = a repo/workspace/folder of modules), choosing a wake phrase, and setting up a first container " +
      "with modules. Guidance only: this returns instructions, it does not perform setup itself. Set the wake " +
      "phrase via the config tool.",
  },
  run: {
    title: "Run (module skill)",
    description:
      "Return the discipline for a module's skill (resolved from the module's type + its own skills), with the target paths and your input injected. " +
      "Guidance only: this returns instructions, it does not perform the work itself.",
  },
};
