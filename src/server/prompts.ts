import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ContainerService, ResolvedContainer } from "../container/service.js";
import type { OkhPaths } from "../config.js";
import { isOkhError } from "../errors.js";
import { loadPreferences } from "../preferences.js";
import { buildAsk, buildContext, buildLearn, buildOnboard, buildReflect, buildRemember } from "../prompts/index.js";

function message(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

/** Resolve targets and build discipline text, converting OkhErrors into an actionable message. */
async function build(
  service: ContainerService,
  container: string | undefined,
  module: string | undefined,
  render: (targets: ResolvedContainer[]) => Promise<string>,
): Promise<GetPromptResult> {
  try {
    const targets = await service.resolveTargets(container, module);
    return message(await render(targets));
  } catch (err) {
    if (isOkhError(err)) {
      return message(`Cannot start this flow: [${err.code}] ${err.message}${err.hint ? `\n\nHint: ${err.hint}` : ""}`);
    }
    throw err;
  }
}

const promptArgs = {
  container: z.string().optional().describe("Container name (default: all registered containers)."),
  module: z.string().optional().describe("Module path within the container."),
};

/** Register the five cognitive prompts (mirrors the prompt-tools in tools.ts). */
export function registerPrompts(server: McpServer, service: ContainerService, paths: OkhPaths): void {
  server.registerPrompt(
    "ask",
    {
      title: "Ask the hub",
      description: "Answer a question from the hub's modules using the okf-ask discipline.",
      argsSchema: { ...promptArgs, question: z.string().optional() },
    },
    (args) => build(service, args.container, args.module, (t) => buildAsk(t, args.question)),
  );

  server.registerPrompt(
    "context",
    {
      title: "Assemble context",
      description: "Assemble a task-relevant working set across the hub.",
      argsSchema: { container: z.string().optional(), task: z.string().optional() },
    },
    (args) => build(service, args.container, undefined, (t) => buildContext(t, args.task)),
  );

  server.registerPrompt(
    "learn",
    {
      title: "Learn into knowledge",
      description: "Integrate new knowledge into a knowledge module (OKF learn gate + writer).",
      argsSchema: { ...promptArgs, knowledge: z.string().optional() },
    },
    (args) => build(service, args.container, args.module, (t) => buildLearn(t, args.knowledge)),
  );

  server.registerPrompt(
    "remember",
    {
      title: "Remember an observation",
      description: "Record a raw observation into a memory module.",
      argsSchema: { ...promptArgs, observation: z.string().optional() },
    },
    (args) => build(service, args.container, args.module, (t) => buildRemember(t, args.observation)),
  );

  server.registerPrompt(
    "reflect",
    {
      title: "Reflect on memory",
      description: "Turn memory/experience into insight and propose updates.",
      argsSchema: { ...promptArgs, focus: z.string().optional() },
    },
    (args) => build(service, args.container, args.module, (t) => buildReflect(t, args.focus)),
  );

  server.registerPrompt(
    "onboard",
    {
      title: "Onboard",
      description: "Guide first-run setup and how to set a wake phrase for the hub.",
      argsSchema: {},
    },
    async () => {
      try {
        const { wakePhrase } = await loadPreferences(paths);
        const targets = await service.resolveTargets();
        return message(await buildOnboard(targets, wakePhrase));
      } catch (err) {
        if (isOkhError(err)) return message(`Cannot start this flow: [${err.code}] ${err.message}`);
        throw err;
      }
    },
  );
}
