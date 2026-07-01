import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { PackService } from "../packs/service.js";
import { isOkhError } from "../errors.js";
import {
  buildAskFlow,
  buildCreateFlow,
  buildLearnFlow,
  buildReviewUpdateFlow,
} from "../discipline/index.js";

function message(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

/** Resolve the pack path, converting OkhErrors into an actionable prompt message. */
async function withPath(
  service: PackService,
  slug: string,
  build: (localPath: string) => Promise<string>,
): Promise<GetPromptResult> {
  try {
    const localPath = await service.path(slug);
    return message(await build(localPath));
  } catch (err) {
    if (isOkhError(err)) {
      return message(`Cannot start this flow: [${err.code}] ${err.message}${err.hint ? `\n\nHint: ${err.hint}` : ""}`);
    }
    throw err;
  }
}

/**
 * Register the discipline flows as MCP prompts (user-triggered). These mirror the
 * flow tools in tools.ts but provide first-class prompt UX where the client
 * supports it.
 */
export function registerPrompts(server: McpServer, service: PackService): void {
  server.registerPrompt(
    "ask",
    {
      title: "Ask a knowledge pack",
      description: "Answer a question from an installed pack using the okf-ask discipline.",
      argsSchema: {
        slug: z.string().describe("The pack to ask."),
        question: z.string().optional().describe("The question to answer."),
      },
    },
    (args) => withPath(service, args.slug, (localPath) => buildAskFlow({ slug: args.slug, localPath, question: args.question })),
  );

  server.registerPrompt(
    "learn",
    {
      title: "Learn into a knowledge pack",
      description: "Fold new knowledge into an installed pack (okf-learn gate + PR write flow).",
      argsSchema: {
        slug: z.string().describe("The pack to teach."),
        knowledge: z.string().optional().describe("The candidate knowledge."),
      },
    },
    (args) => withPath(service, args.slug, (localPath) => buildLearnFlow({ slug: args.slug, localPath, knowledge: args.knowledge })),
  );

  server.registerPrompt(
    "review_update",
    {
      title: "Review & update a knowledge pack",
      description: "Review an installed pack against its scope contract and update it (PR write flow).",
      argsSchema: {
        slug: z.string().describe("The pack to review."),
        focus: z.string().optional().describe("Optional area to focus on."),
      },
    },
    (args) => withPath(service, args.slug, (localPath) => buildReviewUpdateFlow({ slug: args.slug, localPath, focus: args.focus })),
  );

  server.registerPrompt(
    "create",
    {
      title: "Create a new knowledge pack",
      description: "Author a brand-new pack (okf-new-from-repo) and publish it to a fresh origin.",
      argsSchema: {
        slug: z.string().optional().describe("Proposed slug."),
        sourceRepo: z.string().optional().describe("Repo the knowledge is drawn from, if any."),
      },
    },
    async (args) => message(await buildCreateFlow(args)),
  );
}
