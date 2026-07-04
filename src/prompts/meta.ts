import { z } from "zod";

/**
 * Single source of truth for the six flows (`ask`, `context`, `learn`,
 * `remember`, `reflect`, `onboard`). Each flow is exposed BOTH as a prompt-tool
 * (for clients without prompt support) and as an MCP prompt; both must present
 * identical content, so the titles, descriptions, and argument schemas all come
 * from here. Flows never act on their own — they return discipline/instructions
 * for the client agent to follow.
 */

export type FlowName = "ask" | "context" | "learn" | "remember" | "reflect" | "onboard";

/** Argument descriptions, shared so the prompt-tools and prompts stay in lockstep. */
export const argDescriptions = {
  container: "Container name (default: all registered containers).",
  module: "Module path within the container.",
  question: "The question to answer.",
  task: "The task to prepare for.",
  knowledge: "The candidate knowledge to integrate.",
  observation: "The observation to record.",
  focus: "Optional area to focus on.",
} as const;

const container = z.string().optional().describe(argDescriptions.container);
const moduleArg = z.string().optional().describe(argDescriptions.module);

/** Argument shapes per flow, used as both `inputSchema` (tools) and `argsSchema` (prompts). */
export const flowArgShapes = {
  ask: { container, module: moduleArg, question: z.string().optional().describe(argDescriptions.question) },
  context: { container, task: z.string().optional().describe(argDescriptions.task) },
  learn: { container, module: moduleArg, knowledge: z.string().optional().describe(argDescriptions.knowledge) },
  remember: { container, module: moduleArg, observation: z.string().optional().describe(argDescriptions.observation) },
  reflect: { container, module: moduleArg, focus: z.string().optional().describe(argDescriptions.focus) },
  onboard: {},
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
  learn: {
    title: "Learn (flow)",
    description:
      "Return discipline that guides the agent to integrate new knowledge into a knowledge module (OKF). " +
      "Guidance only: this returns instructions, it does not write to the module itself.",
  },
  remember: {
    title: "Remember (flow)",
    description:
      "Return discipline that guides the agent to record an observation into a memory module. " +
      "Guidance only: this returns instructions, it does not write to the module itself.",
  },
  reflect: {
    title: "Reflect (flow)",
    description:
      "Return discipline that guides the agent to turn memory/experience into insight and updates. " +
      "Guidance only: this returns instructions, it does not perform the reflection itself.",
  },
  onboard: {
    title: "Onboard (guided setup)",
    description:
      "Return multi-turn onboarding guidance for a first-run user: intro and terminology (hub = the system; " +
      "container = a repo/workspace/folder of modules), choosing a wake phrase, and setting up a first container " +
      "with modules. Guidance only: this returns instructions, it does not perform setup itself. Set the wake " +
      "phrase via the config tool.",
  },
};
