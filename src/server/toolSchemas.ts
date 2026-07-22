import { z } from "zod";
import {
  MAX_READ_RESOURCE_CHUNK_BYTES,
  MIN_READ_RESOURCE_CHUNK_BYTES,
} from "../resources/embedding.js";

const container = z.string().optional();
const moduleArg = z.string().optional();
const todoPriority = z.enum(["lowest", "low", "normal", "medium", "high", "highest"]);
const workspaceDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const workspaceCheckpoint = z.object({
  summary: z.string(),
  stagedPaths: z.array(z.string()).optional(),
  question: z.string().optional(),
  reason: z.string().optional(),
}).strict();
const workspaceEvidence = z.object({
  criterion: z.string(),
  references: z.array(z.string()),
}).strict();
const workspacePatch = z.object({
  guidance: z.string().nullable().optional(),
  acceptance: z.array(z.string()).optional(),
  title: z.string().optional(),
  goal: z.string().optional(),
  targetDate: workspaceDate.nullable().optional(),
  tags: z.array(z.string()).optional(),
}).strict();

const syncSelection = z.object({
  mode: z.enum(["auto", "shared"]),
  config: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** Bare Zod arg shapes for every tool; descriptions come from resources/tool-meta/<name>.md. */
export const toolShapes = {
  inspect: { container, module: moduleArg },
  use_agent: {
    container: z.string(),
    module: z.string(),
    agent: z.string(),
    task: z.string(),
  },
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
    description: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    create: z.boolean().optional(),
  },
  sync: { container, message: z.string().optional(), action: z.string().min(1).optional() },
  config: {
    set: z.record(z.string(), z.unknown()).optional(),
    container: z.string().optional(),
    module: z.string().optional(),
  },
  onboard: {},
  help: { question: z.string().optional() },
  read_resource: {
    uri: z.string().min(1).max(8_192),
    contentIndex: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
    maxBytes: z.number()
      .int()
      .min(MIN_READ_RESOURCE_CHUNK_BYTES)
      .max(MAX_READ_RESOURCE_CHUNK_BYTES)
      .optional(),
  },
  ask: { container, module: moduleArg, question: z.string().optional() },
  capabilities: {},
  context: { container, task: z.string().optional() },
  run: {
    container: z.string(),
    module: z.string(),
    skill: z.string(),
    input: z.string().optional(),
  },
  dream: { container, module: moduleArg },
  enter: { container: z.string(), module: z.string() },
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
  workspace: {
    operation: z.enum(["list", "get", "create", "start", "report", "update", "intervene"]),
    container: z.string().min(1),
    module: z.string().min(1),
    project: z.string().optional(),
    status: z.enum(["active", "archived", "all"]).optional(),
    attention: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    tagMode: z.enum(["any", "all"]).optional(),
    targetAfter: workspaceDate.optional(),
    targetBefore: workspaceDate.optional(),
    query: z.string().optional(),
    sort: z.enum(["updatedAt", "createdAt", "targetDate", "title"]).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    include: z.array(z.enum(["resume", "results"])).optional(),
    title: z.string().optional(),
    goal: z.string().optional(),
    guidance: z.string().optional(),
    acceptance: z.array(z.string()).optional(),
    targetDate: workspaceDate.optional(),
    correction: z.string().optional(),
    run: z.string().optional(),
    state: z.enum(["paused", "succeeded", "failed", "cancelled"]).optional(),
    checkpoint: workspaceCheckpoint.optional(),
    resultPath: z.string().optional(),
    evidence: z.array(workspaceEvidence).optional(),
    reason: z.string().optional(),
    patch: workspacePatch.optional(),
    action: z.enum(["archive", "unarchive", "restore", "guide", "cancel"]).optional(),
    fromRun: z.string().optional(),
    etag: z.string().optional(),
    commandId: z.string().optional(),
  },
};

export type ToolName = keyof typeof toolShapes;
