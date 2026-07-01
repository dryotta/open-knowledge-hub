import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PackService } from "../packs/service.js";
import { isOkhError } from "../errors.js";
import {
  buildAskFlow,
  buildCreateFlow,
  buildLearnFlow,
  buildReviewUpdateFlow,
} from "../discipline/index.js";

function ok(text: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function fail(message: string, hint?: string): CallToolResult {
  const text = hint ? `${message}\n\nHint: ${hint}` : message;
  return { content: [{ type: "text", text }], isError: true };
}

/** Wrap a handler so expected OkhErrors become clean tool errors. */
function handler<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      if (isOkhError(err)) {
        return fail(`[${err.code}] ${err.message}`, err.hint);
      }
      throw err;
    }
  };
}

const slugArg = { slug: z.string().describe("The pack's unique local slug.") };

/** Register every OKH tool on the given server. */
export function registerTools(server: McpServer, service: PackService): void {
  // --- catalog --------------------------------------------------------------

  server.registerTool(
    "catalog_list",
    {
      title: "List catalog",
      description: "List all packs in the catalog with their install state and origin.",
      inputSchema: {},
    },
    handler(async () => {
      const packs = await service.list();
      if (packs.length === 0) return ok("The catalog is empty.", { packs: [] });
      const lines = packs.map(
        (p) =>
          `- ${p.slug} [${p.state}] ${p.repoUrl}${p.subpath ? ` (subpath: ${p.subpath})` : ""}${p.ref ? ` @${p.ref}` : ""}`,
      );
      return ok(lines.join("\n"), { packs });
    }),
  );

  server.registerTool(
    "catalog_add",
    {
      title: "Register a pack",
      description: "Register a pack in the catalog without installing it.",
      inputSchema: {
        slug: z.string().describe("Unique local slug (lowercase, dash-separated)."),
        repoUrl: z.string().describe("Git URL of the pack's origin repo."),
        subpath: z.string().optional().describe("Subfolder within the repo (default: 'knowledge'). Pass '.' for a pack at the repo root."),
        ref: z.string().optional().describe("Branch or tag to track (default: repo default branch)."),
      },
    },
    handler(async (args) => {
      const entry = await service.add(args);
      return ok(`Registered "${entry.slug}".`, { entry });
    }),
  );

  // --- install lifecycle ----------------------------------------------------

  server.registerTool(
    "pack_install",
    {
      title: "Install a pack",
      description:
        "Clone a pack's origin into the local packs directory. If the pack is not yet registered, pass repoUrl (and optional subpath/ref) to register and install in one step.",
      inputSchema: {
        slug: z.string().describe("Unique local slug."),
        repoUrl: z.string().optional().describe("Origin repo URL (required if not already registered)."),
        subpath: z.string().optional().describe("Subfolder within the repo (default: 'knowledge'). Pass '.' for a pack at the repo root."),
        ref: z.string().optional(),
      },
    },
    handler(async (args) => {
      const entry = await service.install(
        args.slug,
        args.repoUrl ? { slug: args.slug, repoUrl: args.repoUrl, subpath: args.subpath, ref: args.ref } : undefined,
      );
      return ok(`Installed "${entry.slug}" at ${entry.localPath}.`, { entry });
    }),
  );

  server.registerTool(
    "pack_uninstall",
    {
      title: "Uninstall a pack",
      description:
        "Remove a pack's local clone. Blocked when there are unpushed commits unless force is set. Set purge to also drop the catalog entry.",
      inputSchema: {
        ...slugArg,
        force: z.boolean().optional().describe("Discard unpushed commits."),
        purge: z.boolean().optional().describe("Also remove the catalog entry (default: keep as registered)."),
      },
    },
    handler(async (args) => {
      await service.uninstall(args.slug, { force: args.force, purge: args.purge });
      return ok(`Uninstalled "${args.slug}"${args.purge ? " and removed it from the catalog" : ""}.`);
    }),
  );

  server.registerTool(
    "pack_status",
    {
      title: "Pack status",
      description: "Show git status of an installed pack: branch, dirty state, ahead/behind, unpushed commits.",
      inputSchema: { ...slugArg },
    },
    handler(async (args) => {
      const status = await service.status(args.slug);
      if (!status.installed) return ok(`"${args.slug}" is registered but not installed.`, { status });
      const text = [
        `Pack: ${status.slug}`,
        `Branch: ${status.branch}`,
        `Dirty: ${status.dirty}`,
        `Ahead/behind upstream: ${status.ahead}/${status.behind}`,
        `Unpushed commits: ${status.hasUnpushedCommits}`,
        `Path: ${status.localPath}`,
      ].join("\n");
      return ok(text, { status });
    }),
  );

  server.registerTool(
    "pack_pull",
    {
      title: "Update a pack from origin",
      description: "Fetch and fast-forward an installed pack. Local changes are auto-stashed and restored.",
      inputSchema: { ...slugArg },
    },
    handler(async (args) => {
      const { stashed } = await service.pull(args.slug);
      return ok(`Updated "${args.slug}"${stashed ? " (local changes were stashed and restored)" : ""}.`);
    }),
  );

  server.registerTool(
    "pack_path",
    {
      title: "Resolve pack path",
      description: "Return the local filesystem path of an installed pack's root, for reading/writing its files.",
      inputSchema: { ...slugArg },
    },
    handler(async (args) => {
      const path = await service.path(args.slug);
      return ok(path, { path });
    }),
  );

  // --- authoring / publishing ----------------------------------------------

  server.registerTool(
    "pack_create",
    {
      title: "Scaffold a new pack",
      description:
        "Create a new local pack: make the working dir, git init, write a skeleton OKF index.md under the 'knowledge/' subfolder, and register it as installed (unpublished). Follow with pack_publish once authored.",
      inputSchema: {
        slug: z.string().describe("Unique local slug for the new pack."),
        title: z.string().optional(),
        description: z.string().optional(),
        subpath: z.string().optional().describe("Subfolder to author the pack in (default: 'knowledge'). Pass '.' to author at the repo root."),
      },
    },
    handler(async (args) => {
      const entry = await service.create(args);
      return ok(`Scaffolded "${entry.slug}" at ${entry.localPath}. Author it, then run pack_publish.`, { entry });
    }),
  );

  server.registerTool(
    "pack_publish",
    {
      title: "Publish a new pack",
      description:
        "Create a GitHub repo for a locally-created pack and push main. This is the only direct-to-main push; later edits use the PR flow.",
      inputSchema: {
        slug: z.string(),
        repoName: z.string().describe("Name (or owner/name) for the new GitHub repo."),
        visibility: z.enum(["public", "private", "internal"]).optional(),
        description: z.string().optional(),
      },
    },
    handler(async (args) => {
      const { repoUrl } = await service.publish(args);
      return ok(`Published "${args.slug}" to ${repoUrl}.`, { repoUrl });
    }),
  );

  // --- PR write flow --------------------------------------------------------

  server.registerTool(
    "pack_begin_change",
    {
      title: "Begin a change",
      description: "Create the working branch okh/<slug>/<topic> for an edit. Refuses on a dirty working tree.",
      inputSchema: {
        ...slugArg,
        topic: z.string().describe("Short kebab-able topic for the branch name."),
      },
    },
    handler(async (args) => {
      const { branch, localPath } = await service.beginChange(args.slug, args.topic);
      return ok(`On branch ${branch}. Edit files at ${localPath}.`, { branch, localPath });
    }),
  );

  server.registerTool(
    "pack_commit",
    {
      title: "Commit changes",
      description: "Stage all changes and commit them in the pack's working tree.",
      inputSchema: {
        ...slugArg,
        message: z.string().describe("Commit message."),
      },
    },
    handler(async (args) => {
      await service.commit(args.slug, args.message);
      return ok(`Committed changes to "${args.slug}".`);
    }),
  );

  server.registerTool(
    "pack_diff",
    {
      title: "Diff a pack",
      description: "Show a diffstat for an installed pack (default vs HEAD), for summarising changes.",
      inputSchema: {
        ...slugArg,
        ref: z.string().optional().describe("Ref to diff against (default HEAD)."),
      },
    },
    handler(async (args) => {
      const stat = await service.diffStat(args.slug, args.ref);
      return ok(stat || "No changes.", { diffstat: stat });
    }),
  );

  server.registerTool(
    "pack_open_pr",
    {
      title: "Open a pull request",
      description: "Push the current change branch and open a PR into the pack's default branch. Returns the PR URL.",
      inputSchema: {
        ...slugArg,
        title: z.string().describe("PR title."),
        body: z.string().describe("PR body."),
      },
    },
    handler(async (args) => {
      const { prUrl, branch } = await service.openPr(args.slug, args.title, args.body);
      return ok(`Opened PR from ${branch}: ${prUrl}`, { prUrl, branch });
    }),
  );

  // --- flow tools (discipline text; mirror the prompts) ---------------------

  registerFlowTools(server, service);
}

/**
 * The ask/learn/review_update/create flows are exposed as tools (in addition to
 * prompts) so they work in MCP clients without prompt support. Each returns the
 * vendored OKF discipline text, parametrised by the target pack.
 */
function registerFlowTools(server: McpServer, service: PackService): void {
  server.registerTool(
    "ask",
    {
      title: "Ask a pack (flow)",
      description: "Return instructions to answer a question from an installed pack using the okf-ask discipline.",
      inputSchema: {
        ...slugArg,
        question: z.string().optional().describe("The question to answer."),
      },
    },
    handler(async (args) => {
      const localPath = await service.path(args.slug);
      return ok(await buildAskFlow({ slug: args.slug, localPath, question: args.question }));
    }),
  );

  server.registerTool(
    "learn",
    {
      title: "Learn into a pack (flow)",
      description: "Return instructions to fold new knowledge into an installed pack (okf-learn + PR write flow).",
      inputSchema: {
        ...slugArg,
        knowledge: z.string().optional().describe("The candidate knowledge to consider."),
      },
    },
    handler(async (args) => {
      const localPath = await service.path(args.slug);
      return ok(await buildLearnFlow({ slug: args.slug, localPath, knowledge: args.knowledge }));
    }),
  );

  server.registerTool(
    "review_update",
    {
      title: "Review & update a pack (flow)",
      description: "Return instructions to review an installed pack against its scope and update it (PR write flow).",
      inputSchema: {
        ...slugArg,
        focus: z.string().optional().describe("Optional area to focus the review on."),
      },
    },
    handler(async (args) => {
      const localPath = await service.path(args.slug);
      return ok(await buildReviewUpdateFlow({ slug: args.slug, localPath, focus: args.focus }));
    }),
  );

  server.registerTool(
    "create",
    {
      title: "Create a pack (flow)",
      description: "Return instructions to author a brand-new pack (okf-new-from-repo + scaffold/publish policy).",
      inputSchema: {
        slug: z.string().optional().describe("Proposed slug for the new pack."),
        sourceRepo: z.string().optional().describe("Repo the knowledge is drawn from, if any."),
      },
    },
    handler(async (args) => ok(await buildCreateFlow(args))),
  );
}
