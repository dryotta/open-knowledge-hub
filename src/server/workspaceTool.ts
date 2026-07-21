import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import { OkhError } from "../errors.js";
import { moduleFileUri } from "../resources/uris.js";
import type {
  CriterionEvidence,
  RunCheckpoint,
  WorkspaceInput,
  WorkspacePatch,
  WorkspaceResult,
  WorkspaceUpdateInput,
} from "../workspaces/types.js";
import { WorkspaceService } from "../workspaces/service.js";
import { handler, ok, toolReg } from "./toolSupport.js";

export interface WorkspaceToolArgs {
  operation: WorkspaceInput["operation"];
  container: string;
  module: string;
  project?: string;
  status?: "active" | "archived" | "all";
  attention?: boolean;
  tags?: string[];
  tagMode?: "any" | "all";
  targetAfter?: string;
  targetBefore?: string;
  query?: string;
  sort?: "updatedAt" | "createdAt" | "targetDate" | "title";
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string;
  include?: Array<"resume" | "results">;
  title?: string;
  goal?: string;
  guidance?: string;
  acceptance?: string[];
  targetDate?: string;
  correction?: string;
  run?: string;
  state?: "paused" | "succeeded" | "failed" | "cancelled";
  checkpoint?: RunCheckpoint;
  resultPath?: string;
  evidence?: CriterionEvidence[];
  reason?: string;
  patch?: WorkspacePatch;
  action?: "archive" | "unarchive" | "restore" | "guide" | "cancel";
  fromRun?: string;
  etag?: string;
  commandId?: string;
}

const COMMON = ["operation", "container", "module"] as const;
const ALLOWED: Record<WorkspaceInput["operation"], readonly string[]> = {
  list: [
    ...COMMON,
    "status",
    "attention",
    "tags",
    "tagMode",
    "targetAfter",
    "targetBefore",
    "query",
    "sort",
    "order",
    "limit",
    "cursor",
  ],
  get: [...COMMON, "project", "include"],
  create: [
    ...COMMON,
    "project",
    "title",
    "goal",
    "guidance",
    "acceptance",
    "targetDate",
    "tags",
    "commandId",
  ],
  start: [...COMMON, "project", "correction", "etag", "commandId"],
  report: [
    ...COMMON,
    "project",
    "run",
    "state",
    "checkpoint",
    "resultPath",
    "evidence",
    "reason",
    "etag",
    "commandId",
  ],
  update: [...COMMON, "project", "patch", "action", "fromRun", "etag", "commandId"],
  intervene: [
    ...COMMON,
    "project",
    "run",
    "action",
    "guidance",
    "reason",
    "etag",
    "commandId",
  ],
};

function providedKeys(args: WorkspaceToolArgs): string[] {
  return Object.entries(args)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

function requiredString(
  args: WorkspaceToolArgs,
  key: "project" | "run" | "etag" | "commandId",
): string {
  const value = args[key]?.trim();
  if (!value) throw new OkhError("INVALID_ARGUMENT", `${key} is required for ${args.operation}.`);
  return value;
}

function validateOperationFields(args: WorkspaceToolArgs): void {
  const allowed = new Set(ALLOWED[args.operation]);
  const unexpected = providedKeys(args).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new OkhError(
      "INVALID_ARGUMENT",
      `${args.operation} does not accept: ${unexpected.join(", ")}.`,
    );
  }
}

function rejectProvided(
  args: WorkspaceToolArgs,
  fields: Array<keyof WorkspaceToolArgs>,
  context: string,
): void {
  const invalid = fields.filter((field) => args[field] !== undefined);
  if (invalid.length > 0) {
    throw new OkhError(
      "INVALID_ARGUMENT",
      `${context} does not accept: ${invalid.join(", ")}.`,
    );
  }
}

export function toWorkspaceInput(args: WorkspaceToolArgs): WorkspaceInput {
  validateOperationFields(args);
  const base = { container: args.container, module: args.module };
  switch (args.operation) {
    case "list":
      return {
        operation: "list",
        ...base,
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.attention === undefined ? {} : { attention: args.attention }),
        ...(args.tags === undefined ? {} : { tags: args.tags }),
        ...(args.tagMode === undefined ? {} : { tagMode: args.tagMode }),
        ...(args.targetAfter === undefined ? {} : { targetAfter: args.targetAfter }),
        ...(args.targetBefore === undefined ? {} : { targetBefore: args.targetBefore }),
        ...(args.query === undefined ? {} : { query: args.query }),
        ...(args.sort === undefined ? {} : { sort: args.sort }),
        ...(args.order === undefined ? {} : { order: args.order }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      };
    case "get":
      return {
        operation: "get",
        ...base,
        ...(args.project === undefined ? {} : { project: args.project }),
        ...(args.include === undefined ? {} : { include: args.include }),
      };
    case "create":
      return {
        operation: "create",
        ...base,
        ...(args.project === undefined ? {} : { project: args.project }),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.goal === undefined ? {} : { goal: args.goal }),
        ...(args.guidance === undefined ? {} : { guidance: args.guidance }),
        ...(args.acceptance === undefined ? {} : { acceptance: args.acceptance }),
        ...(args.targetDate === undefined ? {} : { targetDate: args.targetDate }),
        ...(args.tags === undefined ? {} : { tags: args.tags }),
        commandId: requiredString(args, "commandId"),
      };
    case "start":
      return {
        operation: "start",
        ...base,
        project: requiredString(args, "project"),
        ...(args.correction === undefined ? {} : { correction: args.correction }),
        etag: requiredString(args, "etag"),
        commandId: requiredString(args, "commandId"),
      };
    case "report": {
      if (!args.state) {
        throw new OkhError("INVALID_ARGUMENT", "state is required for report.");
      }
      if (args.state === "paused") {
        rejectProvided(args, ["resultPath", "evidence", "reason"], "paused reports");
      } else if (args.state === "succeeded") {
        rejectProvided(args, ["checkpoint", "reason"], "succeeded reports");
      } else {
        rejectProvided(args, ["checkpoint", "resultPath", "evidence"], `${args.state} reports`);
      }
      return {
        operation: "report",
        ...base,
        project: requiredString(args, "project"),
        run: requiredString(args, "run"),
        state: args.state,
        ...(args.checkpoint === undefined ? {} : { checkpoint: args.checkpoint }),
        ...(args.resultPath === undefined ? {} : { resultPath: args.resultPath }),
        ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
        ...(args.reason === undefined ? {} : { reason: args.reason }),
        etag: requiredString(args, "etag"),
        commandId: requiredString(args, "commandId"),
      };
    }
    case "update": {
      const action = args.action as WorkspaceUpdateInput["action"] | undefined;
      if (args.action === "guide" || args.action === "cancel") {
        throw new OkhError("INVALID_ARGUMENT", `Action "${args.action}" is valid only for intervene.`);
      }
      return {
        operation: "update",
        ...base,
        ...(args.project === undefined ? {} : { project: args.project }),
        ...(args.patch === undefined ? {} : { patch: args.patch }),
        ...(action === undefined ? {} : { action }),
        ...(args.fromRun === undefined ? {} : { fromRun: args.fromRun }),
        etag: requiredString(args, "etag"),
        commandId: requiredString(args, "commandId"),
      };
    }
    case "intervene":
      if (args.action !== "guide" && args.action !== "cancel") {
        throw new OkhError("INVALID_ARGUMENT", "intervene action must be guide or cancel.");
      }
      if (args.action === "guide") {
        rejectProvided(args, ["reason"], "guide interventions");
      } else {
        rejectProvided(args, ["guidance"], "cancel interventions");
      }
      return {
        operation: "intervene",
        ...base,
        project: requiredString(args, "project"),
        run: requiredString(args, "run"),
        action: args.action,
        ...(args.guidance === undefined ? {} : { guidance: args.guidance }),
        ...(args.reason === undefined ? {} : { reason: args.reason }),
        etag: requiredString(args, "etag"),
        commandId: requiredString(args, "commandId"),
      };
  }
}

function resourceLink(
  uri: string,
  name: string,
  title: string,
  description: string,
  size?: number,
): ResourceLink {
  return {
    type: "resource_link",
    uri,
    name,
    title,
    description,
    ...(size === undefined ? {} : { size }),
  };
}

function workspaceLinks(args: WorkspaceToolArgs, result: WorkspaceResult): ResourceLink[] {
  if ("projects" in result) return [];
  const links: ResourceLink[] = [];
  if (result.workspace) {
    links.push(resourceLink(
      moduleFileUri(args.container, args.module, "README.md"),
      `workspace/${args.container}/${args.module}`,
      `${args.module} workspace`,
      "Workspace guidance and acceptance criteria.",
    ));
  }
  if (result.project) {
    const prefix = `projects/${result.project.id}`;
    links.push(resourceLink(
      moduleFileUri(args.container, args.module, `${prefix}/README.md`),
      `project/${args.container}/${args.module}/${result.project.id}`,
      result.project.title,
      "Canonical project projection.",
    ));
    for (const snapshot of result.resume?.snapshot ?? []) {
      links.push(resourceLink(
        snapshot.uri,
        `snapshot/${result.project.id}/${snapshot.kind}`,
        `${snapshot.kind} snapshot`,
        `Frozen ${snapshot.kind} input for run ${result.resume!.runId}.`,
      ));
    }
    for (const file of result.resume?.currentResult?.files ?? []) {
      links.push(resourceLink(
        file.uri,
        `current-result/${result.project.id}/${file.path}`,
        `Current result: ${file.path}`,
        `Current immutable result file for project ${result.project.id}.`,
        file.size,
      ));
    }
    for (const version of result.results ?? []) {
      for (const file of version.files) {
        links.push(resourceLink(
          moduleFileUri(args.container, args.module, `${prefix}/${version.path}/${file.path}`),
          `result/${result.project.id}/${version.runId}/${file.path}`,
          `${version.runId}: ${file.path}`,
          `Immutable result file from run ${version.runId}.`,
          file.size,
        ));
      }
    }
  }
  return [...new Map(links.map((link) => [link.uri, link])).values()];
}

function formatResourceLinks(links: ResourceLink[]): string {
  if (links.length === 0) return "";
  return "\nResource links (copy an exact URI into read_resource; never construct one):\n"
    + links.map((link) => `- ${link.title ?? link.name}: ${link.uri}`).join("\n");
}

function formatResult(
  args: WorkspaceToolArgs,
  result: WorkspaceResult,
  links: ResourceLink[],
): string {
  let summary: string;
  if ("projects" in result) {
    const next = result.nextCursor ? " More results are available." : "";
    summary = `Found ${result.projects.length} matching project${result.projects.length === 1 ? "" : "s"}.${next}`;
  } else if (result.workspace) {
    summary = `Workspace ${args.container}/${args.module}: ${result.counts?.active ?? 0} active,`
      + ` ${result.counts?.archived ?? 0} archived, ${result.counts?.attention ?? 0} need attention.`;
  } else {
    const project = result.project;
    const replay = "replayed" in result && result.replayed ? " Replayed the recorded outcome." : "";
    if (!project) {
      summary = `Workspace operation ${args.operation} completed.${replay}`;
    } else {
      const run = project.activeRun ? ` Active run: ${project.activeRun}.` : "";
      summary = `${args.operation} ${args.container}/${args.module}/${project.id}:`
        + ` ${project.status}; ETag ${result.etag}.${run}${replay}`;
    }
  }
  const sync = args.operation === "list" || args.operation === "get"
    ? ""
    : `\nRequired next step: before ending this request, call sync for container "${args.container}".`;
  const activeRunGuard = args.operation === "get"
    && "project" in result
    && result.project?.activeRun
      ? `\nActive-run hard stop: do not call workspace with operation "start", even to test the invariant.`
        + ` Project "${result.project.id}" supports only one active run. Resume the existing run,`
        + " or cancel it only when the user explicitly requests cancellation."
      : "";
  const mutationPreflight = args.operation === "get" && "project" in result && result.project
    ? "\nMutation preflight: if the next operation changes state, first invoke an actual RFC 4122"
      + " UUID generator and use its returned value as commandId. Never type or invent a"
      + " UUID-shaped literal."
    : "";
  const discoveryGuard = args.operation === "list" && "projects" in result && result.projects.length > 0
    ? "\nDiscovery-only summaries: after every workspace search completes and one unique match"
      + " is selected, call workspace with operation \"get\" for that project before deciding,"
      + " acting, or refusing. A listed activeRun forbids start but does not replace get."
    : "";
  return summary + formatResourceLinks(links) + discoveryGuard + activeRunGuard + mutationPreflight + sync;
}

export async function registerWorkspaceTool(
  server: McpServer,
  workspaces: WorkspaceService,
): Promise<void> {
  server.registerTool(
    "workspace",
    {
      ...(await toolReg("workspace")),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    handler(async (args: WorkspaceToolArgs) => {
      const result = await workspaces.execute(toWorkspaceInput(args));
      const links = workspaceLinks(args, result);
      if (args.operation !== "list" && args.operation !== "get") {
        await server.sendResourceListChanged();
      }
      return ok(
        formatResult(args, result, links),
        result as unknown as Record<string, unknown>,
        links,
      );
    }),
  );
}
