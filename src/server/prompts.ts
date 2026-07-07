import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import type { ContainerService, ResolvedContainer } from "../container/service.js";
import type { OkhPaths } from "../config.js";
import { isOkhError } from "../errors.js";
import { loadPreferences } from "../preferences.js";
import { buildAsk, buildContext, buildOnboard, buildRun } from "../prompts/index.js";
import { flowArgShapes, flowMeta } from "../prompts/meta.js";

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

/** Register the flows as prompts. Content mirrors the prompt-tools in tools.ts exactly (see prompts/meta.ts). */
export function registerPrompts(server: McpServer, service: ContainerService, paths: OkhPaths): void {
  server.registerPrompt(
    "ask",
    {
      title: flowMeta.ask.title,
      description: flowMeta.ask.description,
      argsSchema: flowArgShapes.ask,
    },
    (args) => build(service, args.container, args.module, (t) => buildAsk(t, args.question)),
  );

  server.registerPrompt(
    "context",
    {
      title: flowMeta.context.title,
      description: flowMeta.context.description,
      argsSchema: flowArgShapes.context,
    },
    (args) => build(service, args.container, undefined, (t) => buildContext(t, args.task)),
  );

  server.registerPrompt(
    "run",
    {
      title: flowMeta.run.title,
      description: flowMeta.run.description,
      argsSchema: flowArgShapes.run,
    },
    async (args) => {
      try {
        const skill = await service.resolveSkill(args.container, args.module, args.skill);
        const targets = await service.resolveTargets(args.container, args.module);
        const target = targets[0];
        const mod = target?.modules.find((m) => m.path === args.module);
        if (!target || !mod) {
          return message(`Cannot start this flow: Container "${args.container}" has no module "${args.module}".`);
        }
        return message(buildRun(target, mod, skill, args.input));
      } catch (err) {
        if (isOkhError(err)) {
          return message(`Cannot start this flow: [${err.code}] ${err.message}${err.hint ? `\n\nHint: ${err.hint}` : ""}`);
        }
        throw err;
      }
    },
  );

  server.registerPrompt(
    "onboard",
    {
      title: flowMeta.onboard.title,
      description: flowMeta.onboard.description,
      argsSchema: flowArgShapes.onboard,
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
