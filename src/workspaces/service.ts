import {
  readdir,
  rename,
  lstat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { OkhPaths } from "../config.js";
import type {
  ContainerService,
  ResolvedContainer,
  ResolvedModule,
} from "../container/service.js";
import { isOkhError, OkhError } from "../errors.js";
import {
  type AgentProfile,
} from "../modules/loaders/agents.js";
import {
  moduleManifestPath,
  moduleManifestSchema,
  type ModuleManifest,
} from "../modules/manifest.js";
import { moduleFileUri } from "../resources/uris.js";
import {
  appendEvents,
  commandReplay,
  pendingTransaction,
  readEvents,
  runHistory,
  successfulResults,
} from "./events.js";
import {
  atomicWrite,
  assertSafePath,
  canonicalJson,
  copySnapshotFile,
  ensureSafeDirectory,
  fileEtag,
  inspectResultTree,
  MAX_RESULT_FILES,
  MAX_RESULT_FILE_BYTES,
  MAX_RESULT_TOTAL_BYTES,
  nextRunId,
  publishResult,
  readSafeTextFile,
  removeSafeTree,
  resolveStagingResult,
  safeJoin,
  sha256,
  stagingDirectory,
  workspaceStagingRoot,
} from "./files.js";
import {
  createProjectReadme,
  createWorkspaceReadme,
  normalizeTags,
  parseProjectReadme,
  parseWorkspaceReadme,
  patchProjectReadme,
  patchWorkspaceReadme,
  validateProjectId,
  validateTargetDate,
} from "./markdown.js";
import type {
  AcceptanceCriterion,
  CriterionEvidence,
  FrozenAgent,
  ProjectRecord,
  ProjectSummary,
  ResultRecord,
  ResumePackage,
  WorkspaceConfig,
  WorkspaceActivityEntry,
  WorkspaceCreateInput,
  WorkspaceEvent,
  WorkspaceGetInput,
  WorkspaceGetResult,
  WorkspaceInput,
  WorkspaceInterveneInput,
  WorkspaceListInput,
  WorkspaceListResult,
  WorkspaceMutationResult,
  WorkspaceReportInput,
  WorkspaceResult,
  WorkspaceStartInput,
  WorkspaceUpdateInput,
} from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ResolvedWorkspace {
  target: ResolvedContainer;
  module: ResolvedModule;
  manifest: ModuleManifest;
  config: WorkspaceConfig;
  readme: ReturnType<typeof parseWorkspaceReadme>;
}

interface PreparedProfile {
  role: "lead" | "pool";
  frozen: FrozenAgent;
  snapshotPath: string;
}

interface ProjectMutation {
  workspace: ResolvedWorkspace;
  project: ProjectRecord;
  events: WorkspaceEvent[];
  input: Exclude<WorkspaceInput, WorkspaceListInput | WorkspaceGetInput | WorkspaceCreateInput>;
  eventType: string;
  subject?: string;
  targetContent: string;
  commitData: Record<string, unknown>;
  outcome: WorkspaceMutationResult;
  applyFiles?: () => Promise<void>;
}

interface WorkspaceMutationContext {
  path: string;
  events: WorkspaceEvent[];
  replay: ReturnType<typeof commandReplay>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function argumentHash(value: unknown): string {
  return sha256(canonicalJson(canonical(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new OkhError("INVALID_ARGUMENT", `${field} is required.`);
  return normalized;
}

function validateCommandId(commandId: string): void {
  if (!UUID_RE.test(commandId)) {
    throw new OkhError("INVALID_ARGUMENT", "commandId must be an RFC 4122 UUID.");
  }
}

function runIds(events: readonly WorkspaceEvent[]): string[] {
  return [...new Set(
    events
      .map((event) => event.subject?.match(/^runs\/(.+)$/u)?.[1])
      .filter((value): value is string => Boolean(value)),
  )];
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
    || (isOkhError(error) && error.code === "NOT_FOUND");
}

function sourceFor(container: string, module: string, project: string): string {
  return `okh://${encodeURIComponent(container)}/${encodeURIComponent(module)}/projects/${encodeURIComponent(project)}`;
}

function projectDirectory(moduleRoot: string, project: string): string {
  validateProjectId(project);
  return join(moduleRoot, "projects", project);
}

function projectReadmePath(moduleRoot: string, project: string): string {
  return join(projectDirectory(moduleRoot, project), "README.md");
}

function projectEventsPath(moduleRoot: string, project: string): string {
  return join(projectDirectory(moduleRoot, project), "events.json");
}

function projectRunsPath(moduleRoot: string, project: string): string {
  return join(projectDirectory(moduleRoot, project), "runs");
}

function workspaceEventsPath(moduleRoot: string): string {
  return join(moduleRoot, ".okh", "workspace-events.json");
}

function workspaceSource(container: string, module: string): string {
  return `okh://${encodeURIComponent(container)}/${encodeURIComponent(module)}`;
}

function displayTitle(module: string): string {
  return module
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function configFromManifest(manifest: ModuleManifest): WorkspaceConfig {
  const lead = manifest.config?.lead;
  const agents = manifest.config?.agents;
  if (typeof lead !== "string" || !lead.trim()) {
    throw new OkhError("INVALID_MANIFEST", "Workspace config requires a non-empty lead reference.");
  }
  if (
    agents !== undefined
    && (!Array.isArray(agents) || agents.some((agent) => typeof agent !== "string" || !agent.trim()))
  ) {
    throw new OkhError("INVALID_MANIFEST", "Workspace config agents must be non-empty strings.");
  }
  return {
    lead: lead.trim(),
    agents: agents ? agents.map((agent) => String(agent).trim()) : [],
  };
}

function criteriaFor(
  workspaceAcceptance: readonly string[],
  projectAcceptance: readonly string[],
): AcceptanceCriterion[] {
  return [
    ...workspaceAcceptance.map((text, index): AcceptanceCriterion => ({
      id: `workspace-${index + 1}`,
      source: "workspace",
      text,
    })),
    ...projectAcceptance.map((text, index): AcceptanceCriterion => ({
      id: `project-${index + 1}`,
      source: "project",
      text,
    })),
  ];
}

function outputContract(): ResumePackage["reportContract"] {
  return {
    states: ["paused", "succeeded", "failed", "cancelled"],
    requiredByState: {
      paused: ["checkpoint"],
      succeeded: ["resultPath", "evidence"],
      failed: ["reason"],
      cancelled: ["reason"],
    },
    outputLimits: {
      maxFiles: MAX_RESULT_FILES,
      maxFileBytes: MAX_RESULT_FILE_BYTES,
      maxTotalBytes: MAX_RESULT_TOTAL_BYTES,
    },
  };
}

function profileMetadata(profile: PreparedProfile): Record<string, unknown> {
  return {
    role: profile.role,
    agent: profile.frozen.agent,
    requestedTools: profile.frozen.requestedTools,
    snapshotPath: profile.snapshotPath,
  };
}

function resultForPath(results: readonly ResultRecord[], path: string | null): ResultRecord | null {
  if (!path) return null;
  return results.find((result) => result.path === path) ?? null;
}

function validProjectActions(project: ProjectRecord, state?: string): string[] {
  if (project.status === "archived") return ["unarchive"];
  if (project.activeRun) {
    return state === "paused"
      ? ["guide", "cancel", "update-project"]
      : ["cancel", "update-project"];
  }
  return ["start", "update-project", "archive", ...(project.result ? ["restore"] : [])];
}

export class WorkspaceService {
  constructor(
    private readonly containers: ContainerService,
    private readonly paths: OkhPaths,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: WorkspaceInput): Promise<WorkspaceResult> {
    switch (input.operation) {
      case "list":
        return this.list(input);
      case "get":
        return this.get(input);
      case "create":
        return this.create(input);
      case "start":
        return this.start(input);
      case "report":
        return this.report(input);
      case "update":
        return this.update(input);
      case "intervene":
        return this.intervene(input);
    }
  }

  async list(input: WorkspaceListInput): Promise<WorkspaceListResult> {
    validateTargetDate(input.targetAfter);
    validateTargetDate(input.targetBefore);
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
      throw new OkhError("INVALID_ARGUMENT", "limit must be an integer from 1 through 100.");
    }
    const workspace = await this.resolveWorkspace(input.container, input.module);
    const projects = await this.loadProjects(workspace);
    const summaries = await Promise.all(projects.map((project) => this.projectSummary(workspace, project)));
    const status = input.status ?? "active";
    const query = input.query?.trim().toLowerCase();
    const tags = normalizeTags(input.tags);
    const filtered = summaries.filter((project) => {
      if (status !== "all" && project.status !== status) return false;
      if (input.attention !== undefined && Boolean(project.attention) !== input.attention) return false;
      if (tags.length > 0) {
        const matches = tags.map((tag) => project.tags.includes(tag));
        if ((input.tagMode ?? "any") === "all" ? matches.some((match) => !match) : !matches.some(Boolean)) {
          return false;
        }
      }
      if (input.targetAfter && (!project.targetDate || project.targetDate < input.targetAfter)) return false;
      if (input.targetBefore && (!project.targetDate || project.targetDate > input.targetBefore)) return false;
      if (
        query
        && !`${project.id} ${project.title} ${project.tags.join(" ")}`.toLowerCase().includes(query)
      ) {
        return false;
      }
      return true;
    });
    const sort = input.sort ?? "updatedAt";
    const order = input.order ?? (sort === "targetDate" || sort === "title" ? "asc" : "desc");
    filtered.sort((left, right) => {
      const leftValue = left[sort] ?? "";
      const rightValue = right[sort] ?? "";
      if (sort === "targetDate" && (!leftValue || !rightValue)) {
        if (!leftValue && !rightValue) {
          return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        }
        return !leftValue ? 1 : -1;
      }
      const compared = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      const idCompared = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      return (order === "asc" ? compared : -compared) || idCompared;
    });
    const limit = input.limit ?? 25;
    const offset = this.decodeCursor(input.cursor);
    const page = filtered.slice(offset, offset + limit);
    return {
      projects: page,
      nextCursor: offset + page.length < filtered.length
        ? Buffer.from(JSON.stringify({ offset: offset + page.length }), "utf8").toString("base64url")
        : null,
    };
  }

  async get(input: WorkspaceGetInput): Promise<WorkspaceGetResult> {
    const workspace = await this.resolveWorkspace(input.container, input.module);
    if (!input.project) return this.workspaceResult(workspace);
    const project = await this.loadProject(workspace.module.absPath, input.project);
    return this.projectResult(workspace, project, input.include ?? []);
  }

  async activity(
    container: string,
    module: string,
    projectId: string,
  ): Promise<WorkspaceActivityEntry[]> {
    const workspace = await this.resolveWorkspace(container, module);
    const project = await this.loadProject(workspace.module.absPath, projectId);
    const events = await readEvents(
      projectEventsPath(workspace.module.absPath, project.id),
      workspace.module.absPath,
    );
    return events
      .filter((event) => event.type.endsWith(".committed"))
      .map((event) => this.activityEntry(event));
  }

  async configure(
    container: string,
    module: string,
    set: { description?: string; lead?: string; agents?: string[] },
  ): Promise<WorkspaceGetResult> {
    return this.containers.withMutationLock(async () => {
      if (Object.keys(set).length === 0) {
        throw new OkhError("INVALID_ARGUMENT", "Workspace configuration requires at least one field.");
      }
      const workspace = await this.resolveWorkspace(container, module);
      const description = set.description?.trim() ?? workspace.manifest.description;
      const lead = set.lead?.trim() ?? workspace.config.lead;
      const agents = set.agents?.map((agent) => agent.trim()) ?? workspace.config.agents;
      if (!description || !lead || agents.some((agent) => !agent)) {
        throw new OkhError(
          "INVALID_ARGUMENT",
          "Workspace description, lead, and every agent reference must be non-empty.",
        );
      }
      const manifest = moduleManifestSchema.parse({
        ...workspace.manifest,
        description,
        config: {
          ...(workspace.manifest.config ?? {}),
          lead,
          agents,
        },
      });
      await atomicWrite(
        moduleManifestPath(workspace.module.absPath),
        stringifyYaml(manifest),
        workspace.module.absPath,
      );
      return this.workspaceResult(await this.resolveWorkspace(container, module));
    });
  }

  async create(input: WorkspaceCreateInput): Promise<WorkspaceMutationResult> {
    validateCommandId(input.commandId);
    return this.containers.withMutationLock(async () => {
      const workspace = await this.resolveWorkspaceBase(input.container, input.module);
      if (!input.project) return this.initializeWorkspace(workspace, input);
      return this.createProject(workspace, input);
    });
  }

  async start(input: WorkspaceStartInput): Promise<WorkspaceMutationResult> {
    validateCommandId(input.commandId);
    return this.containers.withMutationLock(async () => {
      const workspace = await this.resolveWorkspace(input.container, input.module);
      const project = await this.loadProject(workspace.module.absPath, input.project);
      const eventsPath = projectEventsPath(workspace.module.absPath, project.id);
      const events = await readEvents(eventsPath, workspace.module.absPath);
      const hash = argumentHash(input);
      const replay = commandReplay(events, input.commandId, hash);
      if (replay.kind === "committed") return replay.outcome!;
      this.assertTransactionAvailable(events, replay);
      if (replay.kind === "none") {
        this.requireEtag(project, input.etag);
        if (project.status !== "active") {
          throw new OkhError("CONFLICT", "Archived projects cannot start a run.");
        }
        if (project.activeRun) {
          throw new OkhError("CONFLICT", `Project already has active run "${project.activeRun}".`);
        }
      }

      const time = this.mutationTime(replay.prepared);
      const runId = replay.prepared?.subject?.replace(/^runs\//u, "")
        ?? nextRunId(runIds(events), this.now());
      const runRoot = join(projectRunsPath(workspace.module.absPath, project.id), runId);
      const snapshotRoot = join(runRoot, "snapshot");
      const preparedData = this.preparedCommitData(replay.prepared);
      const profiles = replay.prepared
        ? await this.profilesFromRecords(
            workspace,
            project.id,
            runId,
            preparedData.profiles,
          )
        : await this.resolveProfiles(workspace);
      const criteria = replay.prepared && Array.isArray(preparedData.criteria)
        ? preparedData.criteria as AcceptanceCriterion[]
        : criteriaFor(workspace.readme.acceptance, project.acceptance);
      const results = successfulResults(events);
      const currentResult = resultForPath(results, project.result);
      if (project.result && !currentResult && replay.kind === "none") {
        throw new OkhError("INVALID_MANIFEST", "The current project result has no successful run event.");
      }
      if (currentResult && replay.kind === "none") {
        await this.assertResultIntact(workspace, project, currentResult);
      }
      const snapshot = await this.prepareSnapshot(
        workspace,
        project,
        runId,
        profiles,
        replay.kind === "prepared",
      );
      const stagingPath = replay.prepared && typeof preparedData.stagingPath === "string"
        ? preparedData.stagingPath
        : stagingDirectory(
            this.paths,
            input.container,
            input.module,
            project.id,
            runId,
          );
      const targetContent = patchProjectReadme(project, {
        activeRun: runId,
        updatedAt: time,
      });
      const targetProject = parseProjectReadme(project.id, targetContent, sha256(targetContent));
      const resume = this.buildResumePackage({
        workspace,
        project: targetProject,
        runId,
        snapshot,
        currentResult,
        criteria,
        profiles,
        stagingPath,
        checkpoint: null,
        guidance: [],
      });
      const outcome: WorkspaceMutationResult = {
        project: targetProject,
        resume,
        etag: targetProject.etag,
        validActions: ["cancel", "update-project"],
      };
      const commitData = {
        runId,
        correction: input.correction?.trim() || null,
        criteria,
        profiles: profiles.map(profileMetadata),
        snapshot,
        stagingPath,
        currentResult,
      };
      return this.commitProjectMutation({
        workspace,
        project,
        events,
        input,
        eventType: "dev.okh.workspace.run.started",
        subject: `runs/${runId}`,
        targetContent,
        commitData,
        outcome,
        applyFiles: async () => {
          await ensureSafeDirectory(workspace.module.absPath, snapshotRoot);
          const stagingRoot = workspaceStagingRoot(this.paths);
          await ensureSafeDirectory(this.paths.home, stagingRoot);
          await ensureSafeDirectory(stagingRoot, stagingPath);
        },
      });
    });
  }

  async report(input: WorkspaceReportInput): Promise<WorkspaceMutationResult> {
    validateCommandId(input.commandId);
    this.validateReportFields(input);
    return this.containers.withMutationLock(async () => {
      const workspace = await this.resolveWorkspace(input.container, input.module);
      const project = await this.loadProject(workspace.module.absPath, input.project);
      const events = await readEvents(
        projectEventsPath(workspace.module.absPath, project.id),
        workspace.module.absPath,
      );
      const hash = argumentHash(input);
      const replay = commandReplay(events, input.commandId, hash);
      if (replay.kind === "committed") return replay.outcome!;
      this.assertTransactionAvailable(events, replay);
      const history = runHistory(events, input.run);
      if (replay.kind === "none") {
        this.requireEtag(project, input.etag);
        if (project.activeRun !== input.run) {
          throw new OkhError("CONFLICT", `Run "${input.run}" is not the project's active run.`);
        }
        if (["succeeded", "failed", "cancelled"].includes(history.state)) {
          throw new OkhError("CONFLICT", `Run "${input.run}" is already terminal.`);
        }
      }

      const time = this.mutationTime(replay.prepared);
      const patch: Parameters<typeof patchProjectReadme>[1] = { updatedAt: time };
      let applyFiles: (() => Promise<void>) | undefined;
      let commitData: Record<string, unknown>;
      let eventType: string;
      if (input.state === "paused") {
        if (!input.checkpoint?.summary.trim()) {
          throw new OkhError("INVALID_ARGUMENT", "paused reports require a checkpoint summary.");
        }
        eventType = "dev.okh.workspace.run.paused";
        commitData = { checkpoint: input.checkpoint };
      } else if (input.state === "succeeded") {
        const resultPath = nonBlank(input.resultPath, "resultPath");
        const start = this.startEvent(events, input.run);
        const criteria = Array.isArray(start.data.criteria)
          ? start.data.criteria as AcceptanceCriterion[]
          : [];
        const evidence = input.evidence ?? [];
        this.validateEvidence(criteria, evidence);
        const staging = stagingDirectory(this.paths, input.container, input.module, project.id, input.run);
        const stagingRoot = workspaceStagingRoot(this.paths);
        await assertSafePath(stagingRoot, staging, { requireDirectory: true });
        const source = resolveStagingResult(staging, resultPath);
        await assertSafePath(stagingRoot, source, { requireDirectory: true });
        const destination = join(projectRunsPath(workspace.module.absPath, project.id), input.run, "result");
        const preparedData = this.preparedCommitData(replay.prepared);
        const preparedFiles = Array.isArray(preparedData.files)
          ? preparedData.files as ResultRecord["files"]
          : undefined;
        const preparedTreeHash = typeof preparedData.treeHash === "string"
          ? preparedData.treeHash
          : undefined;
        const inspected = preparedFiles && preparedTreeHash
          ? { files: preparedFiles, treeHash: preparedTreeHash }
          : await inspectResultTree(source, stagingRoot);
        const relativeResult = `runs/${input.run}/result`;
        patch.activeRun = null;
        patch.result = relativeResult;
        eventType = "dev.okh.workspace.run.succeeded";
        commitData = {
          resultPath: relativeResult,
          treeHash: inspected.treeHash,
          files: inspected.files,
          evidence,
        };
        applyFiles = async () => {
          const existing = await lstat(destination).catch((error) => {
            if (isNotFound(error)) return undefined;
            throw error;
          });
          if (existing) {
            const current = await inspectResultTree(destination, workspace.module.absPath);
            if (current.treeHash !== inspected.treeHash) {
              throw new OkhError("CONFLICT", "Published result conflicts with the prepared result.");
            }
            return;
          }
          await publishResult(
            source,
            destination,
            inspected,
            stagingRoot,
            workspace.module.absPath,
          );
        };
      } else {
        const reason = nonBlank(input.reason, "reason");
        patch.activeRun = null;
        eventType = input.state === "failed"
          ? "dev.okh.workspace.run.failed"
          : "dev.okh.workspace.run.cancelled";
        commitData = { reason };
      }
      const targetContent = patchProjectReadme(project, patch);
      const target = parseProjectReadme(project.id, targetContent, sha256(targetContent));
      const outcome: WorkspaceMutationResult = {
        project: target,
        etag: target.etag,
        validActions: validProjectActions(target, input.state),
      };
      return this.commitProjectMutation({
        workspace,
        project,
        events,
        input,
        eventType,
        subject: `runs/${input.run}`,
        targetContent,
        commitData,
        outcome,
        ...(applyFiles ? { applyFiles } : {}),
      });
    });
  }

  async update(input: WorkspaceUpdateInput): Promise<WorkspaceMutationResult> {
    validateCommandId(input.commandId);
    return this.containers.withMutationLock(async () => {
      const workspace = await this.resolveWorkspace(input.container, input.module);
      if (!input.project) return this.updateWorkspace(workspace, input);
      const project = await this.loadProject(workspace.module.absPath, input.project);
      if (Boolean(input.patch) === Boolean(input.action)) {
        throw new OkhError("INVALID_ARGUMENT", "update requires exactly one patch or action.");
      }
      if (input.patch && Object.values(input.patch).every((value) => value === undefined)) {
        throw new OkhError("INVALID_ARGUMENT", "update patch must contain at least one field.");
      }
      if (input.action !== "restore" && input.fromRun !== undefined) {
        throw new OkhError("INVALID_ARGUMENT", "fromRun is valid only with the restore action.");
      }
      const events = await readEvents(
        projectEventsPath(workspace.module.absPath, project.id),
        workspace.module.absPath,
      );
      const replay = commandReplay(events, input.commandId, argumentHash(input));
      if (replay.kind === "committed") return replay.outcome!;
      this.assertTransactionAvailable(events, replay);
      if (replay.kind === "none") {
        this.requireEtag(project, input.etag);
        if (project.status === "archived" && input.action !== "unarchive") {
          throw new OkhError("CONFLICT", "Archived projects are frozen; unarchive before changing them.");
        }
      }
      const time = this.mutationTime(replay.prepared);
      const patch: Parameters<typeof patchProjectReadme>[1] = {
        ...(input.patch ?? {}),
        updatedAt: time,
      };
      let eventType = "dev.okh.workspace.project.updated";
      const commitData: Record<string, unknown> = input.patch ? { patch: input.patch } : {};
      if (input.action === "archive") {
        if (replay.kind === "none") {
          if (project.activeRun) throw new OkhError("CONFLICT", "Cancel or finish the active run before archiving.");
          if (project.status !== "active") throw new OkhError("CONFLICT", "Project is already archived.");
        }
        patch.status = "archived" as const;
        eventType = "dev.okh.workspace.project.archived";
      } else if (input.action === "unarchive") {
        if (replay.kind === "none" && project.status !== "archived") {
          throw new OkhError("CONFLICT", "Project is already active.");
        }
        patch.status = "active" as const;
        eventType = "dev.okh.workspace.project.unarchived";
      } else if (input.action === "restore") {
        if (replay.kind === "none" && project.activeRun) {
          throw new OkhError("CONFLICT", "Cancel or finish the active run before restoring.");
        }
        const fromRun = nonBlank(input.fromRun, "fromRun");
        const results = successfulResults(events);
        const result = results.find((candidate) => candidate.runId === fromRun);
        if (!result) throw new OkhError("NOT_FOUND", `Run "${fromRun}" has no successful result.`);
        await this.assertResultIntact(workspace, project, result);
        const current = resultForPath(results, project.result);
        if (project.result && !current && replay.kind === "none") {
          throw new OkhError("INVALID_MANIFEST", "The current project result has no successful run event.");
        }
        if (current) await this.assertResultIntact(workspace, project, current);
        patch.result = result.path;
        commitData.fromRun = fromRun;
        commitData.resultPath = result.path;
        eventType = "dev.okh.workspace.result.restored";
      }
      const targetContent = patchProjectReadme(project, patch);
      const target = parseProjectReadme(project.id, targetContent, sha256(targetContent));
      const outcome: WorkspaceMutationResult = {
        project: target,
        etag: target.etag,
        validActions: validProjectActions(target),
      };
      return this.commitProjectMutation({
        workspace,
        project,
        events,
        input,
        eventType,
        targetContent,
        commitData,
        outcome,
      });
    });
  }

  async intervene(input: WorkspaceInterveneInput): Promise<WorkspaceMutationResult> {
    validateCommandId(input.commandId);
    this.validateInterventionFields(input);
    return this.containers.withMutationLock(async () => {
      const workspace = await this.resolveWorkspace(input.container, input.module);
      const project = await this.loadProject(workspace.module.absPath, input.project);
      const events = await readEvents(
        projectEventsPath(workspace.module.absPath, project.id),
        workspace.module.absPath,
      );
      const replay = commandReplay(events, input.commandId, argumentHash(input));
      if (replay.kind === "committed") return replay.outcome!;
      this.assertTransactionAvailable(events, replay);
      const history = runHistory(events, input.run);
      if (replay.kind === "none") {
        this.requireEtag(project, input.etag);
        if (project.activeRun !== input.run) {
          throw new OkhError("CONFLICT", `Run "${input.run}" is not the project's active run.`);
        }
      }
      const time = this.mutationTime(replay.prepared);
      const patch: Parameters<typeof patchProjectReadme>[1] = { updatedAt: time };
      let eventType: string;
      let commitData: Record<string, unknown>;
      if (input.action === "guide") {
        if (replay.kind === "none" && history.state !== "paused") {
          throw new OkhError("CONFLICT", "Guidance can be added only to a paused run.");
        }
        const guidance = nonBlank(input.guidance, "guidance");
        eventType = "dev.okh.workspace.run.guided";
        commitData = { guidance };
      } else {
        if (replay.kind === "none" && ["succeeded", "failed", "cancelled"].includes(history.state)) {
          throw new OkhError("CONFLICT", `Run "${input.run}" is already terminal.`);
        }
        patch.activeRun = null;
        eventType = "dev.okh.workspace.run.cancelled";
        commitData = { reason: input.reason?.trim() || "Cancelled by the user." };
      }
      const targetContent = patchProjectReadme(project, patch);
      const target = parseProjectReadme(project.id, targetContent, sha256(targetContent));
      const outcome: WorkspaceMutationResult = {
        project: target,
        etag: target.etag,
        validActions: validProjectActions(target, input.action === "guide" ? "active" : "cancelled"),
      };
      return this.commitProjectMutation({
        workspace,
        project,
        events,
        input,
        eventType,
        subject: `runs/${input.run}`,
        targetContent,
        commitData,
        outcome,
      });
    });
  }

  private decodeCursor(cursor: string | undefined): number {
    if (!cursor) return 0;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
      if (
        !parsed
        || typeof parsed !== "object"
        || !("offset" in parsed)
        || !Number.isInteger((parsed as { offset: unknown }).offset)
        || Number((parsed as { offset: number }).offset) < 0
      ) {
        throw new Error("invalid");
      }

      return (parsed as { offset: number }).offset;
    } catch {
      throw new OkhError("INVALID_ARGUMENT", "cursor is invalid.");
    }
  }

  private validateReportFields(input: WorkspaceReportInput): void {
    const invalid = input.state === "paused"
      ? [
          input.resultPath === undefined ? undefined : "resultPath",
          input.evidence === undefined ? undefined : "evidence",
          input.reason === undefined ? undefined : "reason",
        ]
      : input.state === "succeeded"
        ? [
            input.checkpoint === undefined ? undefined : "checkpoint",
            input.reason === undefined ? undefined : "reason",
          ]
        : [
            input.checkpoint === undefined ? undefined : "checkpoint",
            input.resultPath === undefined ? undefined : "resultPath",
            input.evidence === undefined ? undefined : "evidence",
          ];
    const fields = invalid.filter((field): field is string => Boolean(field));
    if (fields.length > 0) {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `${input.state} reports do not accept: ${fields.join(", ")}.`,
      );
    }
  }

  private validateInterventionFields(input: WorkspaceInterveneInput): void {
    if (input.action === "guide" && input.reason !== undefined) {
      throw new OkhError("INVALID_ARGUMENT", "guide interventions do not accept reason.");
    }
    if (input.action === "cancel" && input.guidance !== undefined) {
      throw new OkhError("INVALID_ARGUMENT", "cancel interventions do not accept guidance.");
    }
  }

  private async resolveWorkspaceBase(
    container: string,
    module: string,
  ): Promise<Omit<ResolvedWorkspace, "readme"> & { readme?: ResolvedWorkspace["readme"] }> {
    const targets = await this.containers.resolveTargets(container, module);
    const target = targets[0];
    const resolved = target?.modules.find((candidate) => candidate.path === module);
    if (!target || !resolved) {
      throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
    }
    if (resolved.type !== "workspace") {
      throw new OkhError("INVALID_ARGUMENT", `Module "${module}" is not a workspace.`);
    }
    await assertSafePath(resolved.absPath, resolved.absPath, { requireDirectory: true });
    const manifestPath = moduleManifestPath(resolved.absPath);
    const manifestRaw = await readSafeTextFile(resolved.absPath, manifestPath);
    let manifestValue: unknown;
    try {
      manifestValue = parseYaml(manifestRaw);
    } catch {
      throw new OkhError("INVALID_MANIFEST", `${manifestPath} is not valid YAML.`);
    }
    const parsedManifest = moduleManifestSchema.safeParse(manifestValue);
    if (!parsedManifest.success) {
      throw new OkhError(
        "INVALID_MANIFEST",
        `${manifestPath} does not match the expected schema: ${parsedManifest.error.message}`,
      );
    }
    const manifest = parsedManifest.data;
    const config = configFromManifest(manifest);
    const readmePath = join(resolved.absPath, "README.md");
    const content = await readSafeTextFile(resolved.absPath, readmePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    return {
      target,
      module: resolved,
      manifest,
      config,
      ...(content !== undefined
        ? { readme: parseWorkspaceReadme(content, sha256(content), displayTitle(module)) }
        : {}),
    };
  }

  private async resolveWorkspace(container: string, module: string): Promise<ResolvedWorkspace> {
    const workspace = await this.resolveWorkspaceBase(container, module);
    if (!workspace.readme) {
      throw new OkhError(
        "INVALID_MANIFEST",
        `Workspace "${container}/${module}" is not initialized.`,
        "Run its initialize skill first.",
      );
    }
    return workspace as ResolvedWorkspace;
  }

  private async loadProject(moduleRoot: string, id: string): Promise<ProjectRecord> {
    validateProjectId(id);
    const path = projectReadmePath(moduleRoot, id);
    await assertSafePath(moduleRoot, projectDirectory(moduleRoot, id), {
      requireDirectory: true,
    }).catch((error) => {
      if (isNotFound(error)) throw new OkhError("NOT_FOUND", `Project "${id}" does not exist.`);
      throw error;
    });
    let content: string;
    try {
      content = await readSafeTextFile(moduleRoot, path);
    } catch (error) {
      if (isNotFound(error)) throw new OkhError("NOT_FOUND", `Project "${id}" does not exist.`);
      throw error;
    }
    return parseProjectReadme(id, content, sha256(content));
  }

  private async loadProjects(workspace: ResolvedWorkspace): Promise<ProjectRecord[]> {
    const root = join(workspace.module.absPath, "projects");
    await assertSafePath(workspace.module.absPath, root, {
      allowMissing: true,
      requireDirectory: true,
    });
    const entries = await readdir(root, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const projects: ProjectRecord[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      projects.push(await this.loadProject(workspace.module.absPath, entry.name));
    }
    return projects;
  }

  private async projectSummary(
    workspace: ResolvedWorkspace,
    project: ProjectRecord,
  ): Promise<ProjectSummary> {
    const events = await readEvents(
      projectEventsPath(workspace.module.absPath, project.id),
      workspace.module.absPath,
    );
    const results = successfulResults(events);
    const current = resultForPath(results, project.result);
    if (project.result && !current) {
      throw new OkhError("INVALID_MANIFEST", `Project "${project.id}" references an unknown result.`);
    }
    const history = project.activeRun ? runHistory(events, project.activeRun) : undefined;
    return {
      id: project.id,
      title: project.title,
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      ...(project.targetDate ? { targetDate: project.targetDate } : {}),
      tags: project.tags,
      activeRun: project.activeRun,
      currentResult: current
        ? { runId: current.runId, path: current.path, treeHash: current.treeHash }
        : null,
      attention: history?.state === "paused" && history.checkpoint
        ? {
            kind: "paused",
            summary: history.checkpoint.summary,
            ...(history.checkpoint.question ? { question: history.checkpoint.question } : {}),
          }
        : null,
    };
  }

  private async workspaceResult(workspace: ResolvedWorkspace): Promise<WorkspaceGetResult> {
    const projects = await this.loadProjects(workspace);
    const summaries = await Promise.all(projects.map((project) => this.projectSummary(workspace, project)));
    const agentIssues = await this.agentIssues(workspace);
    return {
      workspace: {
        container: workspace.target.name,
        module: workspace.module.path,
        description: workspace.manifest.description,
        guidance: workspace.readme.guidance,
        acceptance: workspace.readme.acceptance,
        lead: workspace.config.lead,
        agents: workspace.config.agents,
        agentHealth: agentIssues.length === 0 ? "valid" : "invalid",
        agentIssues,
      },
      counts: {
        active: projects.filter((project) => project.status === "active").length,
        archived: projects.filter((project) => project.status === "archived").length,
        activeRuns: projects.filter((project) => project.activeRun).length,
        attention: summaries.filter((project) => project.attention).length,
      },
      etag: workspace.readme.etag,
      validActions: ["update", "create-project"],
    };
  }

  private async projectResult(
    workspace: ResolvedWorkspace,
    project: ProjectRecord,
    include: Array<"resume" | "results">,
  ): Promise<WorkspaceGetResult> {
    const events = await readEvents(
      projectEventsPath(workspace.module.absPath, project.id),
      workspace.module.absPath,
    );
    const results = successfulResults(events);
    if (project.result && !resultForPath(results, project.result)) {
      throw new OkhError("INVALID_MANIFEST", `Project "${project.id}" references an unknown result.`);
    }
    const history = project.activeRun ? runHistory(events, project.activeRun) : undefined;
    const result: WorkspaceGetResult = {
      project,
      etag: project.etag,
      validActions: validProjectActions(project, history?.state),
    };
    if (include.includes("results")) result.results = results;
    if (include.includes("resume")) {
      result.resume = project.activeRun
        ? await this.resumeFromEvents(workspace, project, events, project.activeRun)
        : null;
    }
    return result;
  }

  private async initializeWorkspace(
    workspace: Omit<ResolvedWorkspace, "readme"> & { readme?: ResolvedWorkspace["readme"] },
    input: WorkspaceCreateInput,
  ): Promise<WorkspaceMutationResult> {
    const command = await this.workspaceMutationContext(workspace, input);
    if (command.replay.kind === "committed") return command.replay.outcome!;
    if (input.title || input.goal || input.targetDate || input.tags) {
      throw new OkhError("INVALID_ARGUMENT", "Workspace initialization accepts only guidance and acceptance.");
    }
    const content = createWorkspaceReadme(
      displayTitle(workspace.module.path),
      input.guidance,
      input.acceptance,
    );
    if (workspace.readme) {
      if (workspace.readme.content !== content) {
        throw new OkhError("ALREADY_EXISTS", "The workspace is already initialized with different content.");
      }
    }
    const readme = parseWorkspaceReadme(
      content,
      sha256(content),
      displayTitle(workspace.module.path),
    );
    const target = { ...workspace, readme } as ResolvedWorkspace;
    const outcome = await this.workspaceResult(target);
    return this.commitWorkspaceMutation({
      workspace,
      input,
      command,
      eventType: "dev.okh.workspace.initialized",
      targetContent: content,
      outcome,
      applyFiles: async () => {
        await ensureSafeDirectory(
          workspace.module.absPath,
          join(workspace.module.absPath, "projects"),
        );
      },
    });
  }

  private async createProject(
    workspaceBase: Omit<ResolvedWorkspace, "readme"> & { readme?: ResolvedWorkspace["readme"] },
    input: WorkspaceCreateInput,
  ): Promise<WorkspaceMutationResult> {
    if (!workspaceBase.readme) {
      throw new OkhError("INVALID_MANIFEST", "Initialize the workspace before creating projects.");
    }
    const workspace = workspaceBase as ResolvedWorkspace;
    const projectId = nonBlank(input.project, "project");
    validateProjectId(projectId);
    const directory = projectDirectory(workspace.module.absPath, projectId);
    await assertSafePath(workspace.module.absPath, join(workspace.module.absPath, "projects"), {
      requireDirectory: true,
    });
    const existing = await lstat(directory).catch((error) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (existing) {
      await assertSafePath(workspace.module.absPath, directory, { requireDirectory: true });
      const events = await readEvents(
        projectEventsPath(workspace.module.absPath, projectId),
        workspace.module.absPath,
      );
      const replay = commandReplay(events, input.commandId, argumentHash(input));
      if (replay.kind === "committed") return replay.outcome!;
      throw new OkhError("ALREADY_EXISTS", `Project "${projectId}" already exists.`);
    }
    const time = this.now().toISOString();
    const content = createProjectReadme({
      title: nonBlank(input.title, "title"),
      goal: nonBlank(input.goal, "goal"),
      createdAt: time,
      ...(input.guidance ? { guidance: input.guidance } : {}),
      ...(input.acceptance ? { acceptance: input.acceptance } : {}),
      ...(input.targetDate ? { targetDate: input.targetDate } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
    });
    const project = parseProjectReadme(projectId, content, sha256(content));
    const outcome: WorkspaceMutationResult = {
      project,
      etag: project.etag,
      validActions: validProjectActions(project),
    };
    const temporary = `${directory}.tmp-${input.commandId}`;
    await removeSafeTree(workspace.module.absPath, temporary);
    await ensureSafeDirectory(workspace.module.absPath, join(temporary, "runs"));
    await atomicWrite(join(temporary, "README.md"), content, workspace.module.absPath);
    const source = sourceFor(input.container, input.module, projectId);
    const hash = argumentHash(input);
    const eventBase = {
      source,
      time,
      commandId: input.commandId,
      data: { argumentHash: hash, outcome },
    };
    await appendEvents(join(temporary, "events.json"), [
      { ...eventBase, type: "dev.okh.workspace.project.created.prepared" },
      { ...eventBase, type: "dev.okh.workspace.project.created.committed" },
    ], workspace.module.absPath);
    try {
      await assertSafePath(workspace.module.absPath, dirname(directory), { requireDirectory: true });
      await rename(temporary, directory);
      await assertSafePath(workspace.module.absPath, directory, { requireDirectory: true });
    } catch (error) {
      await removeSafeTree(workspace.module.absPath, temporary).catch(() => undefined);
      throw error;
    }
    return outcome;
  }

  private async updateWorkspace(
    workspace: ResolvedWorkspace,
    input: WorkspaceUpdateInput,
  ): Promise<WorkspaceMutationResult> {
    const command = await this.workspaceMutationContext(workspace, input);
    if (command.replay.kind === "committed") return command.replay.outcome!;
    if (!input.patch || input.action) {
      throw new OkhError("INVALID_ARGUMENT", "Workspace update requires one patch and no action.");
    }
    if (Object.values(input.patch).every((value) => value === undefined)) {
      throw new OkhError("INVALID_ARGUMENT", "Workspace update patch must contain at least one field.");
    }
    if (
      input.patch.title !== undefined
      || input.patch.goal !== undefined
      || input.patch.targetDate !== undefined
      || input.patch.tags !== undefined
    ) {
      throw new OkhError("INVALID_ARGUMENT", "Those patch fields apply only to projects.");
    }
    const content = patchWorkspaceReadme(workspace.readme, input.patch);
    if (command.replay.kind === "none" && workspace.readme.etag !== input.etag) {
      throw new OkhError("CONFLICT", "Workspace README changed; call get and retry.");
    }
    const target = {
      ...workspace,
      readme: parseWorkspaceReadme(
        content,
        sha256(content),
        displayTitle(workspace.module.path),
      ),
    };
    const outcome = await this.workspaceResult(target);
    return this.commitWorkspaceMutation({
      workspace,
      input,
      command,
      eventType: "dev.okh.workspace.updated",
      targetContent: content,
      outcome,
    });
  }

  private async workspaceMutationContext(
    workspace: Omit<ResolvedWorkspace, "readme"> & { readme?: ResolvedWorkspace["readme"] },
    input: WorkspaceCreateInput | WorkspaceUpdateInput,
  ): Promise<WorkspaceMutationContext> {
    const path = workspaceEventsPath(workspace.module.absPath);
    const events = await readEvents(path, workspace.module.absPath);
    const replay = commandReplay(events, input.commandId, argumentHash(input));
    this.assertTransactionAvailable(events, replay);
    return { path, events, replay };
  }

  private workspacePreparedOutcome(event: WorkspaceEvent): WorkspaceMutationResult {
    const outcome = event.data.outcome;
    if (
      !isRecord(outcome)
      || !isRecord(outcome.workspace)
      || typeof outcome.etag !== "string"
    ) {
      throw new OkhError("INVALID_MANIFEST", "Prepared workspace event has no recoverable outcome.");
    }
    return outcome as unknown as WorkspaceMutationResult;
  }

  private async commitWorkspaceMutation(mutation: {
    workspace: Omit<ResolvedWorkspace, "readme"> & { readme?: ResolvedWorkspace["readme"] };
    input: WorkspaceCreateInput | WorkspaceUpdateInput;
    command: WorkspaceMutationContext;
    eventType: string;
    targetContent: string;
    outcome: WorkspaceMutationResult;
    applyFiles?: () => Promise<void>;
  }): Promise<WorkspaceMutationResult> {
    const { workspace, command } = mutation;
    const hash = argumentHash(mutation.input);
    let targetContent = mutation.targetContent;
    let targetEtag = sha256(targetContent);
    let outcome = mutation.outcome;
    let preimageEtag: string | null = workspace.readme?.etag ?? null;
    let prepared = command.replay.prepared;
    if (command.replay.kind === "prepared") {
      prepared = command.replay.prepared!;
      outcome = this.workspacePreparedOutcome(prepared);
      if (
        typeof prepared.data.targetContent !== "string"
        || typeof prepared.data.targetEtag !== "string"
        || (prepared.data.preimageEtag !== null && typeof prepared.data.preimageEtag !== "string")
      ) {
        throw new OkhError("INVALID_MANIFEST", "Prepared workspace event has invalid recovery data.");
      }
      targetContent = prepared.data.targetContent;
      targetEtag = prepared.data.targetEtag;
      preimageEtag = prepared.data.preimageEtag;
      if (sha256(targetContent) !== targetEtag) {
        throw new OkhError("INVALID_MANIFEST", "Prepared workspace target content does not match its hash.");
      }
      const current = await fileEtag(
        join(workspace.module.absPath, "README.md"),
        workspace.module.absPath,
      ).catch((error) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (current === targetEtag) {
        await this.appendWorkspaceCommit(mutation, prepared, hash, outcome);
        return { ...outcome, replayed: true };
      }
      if (current !== preimageEtag) {
        throw new OkhError("CONFLICT", "Prepared workspace mutation conflicts with current workspace state.");
      }
    } else {
      const appended = await appendEvents(command.path, [{
        source: workspaceSource(workspace.target.name, workspace.module.path),
        type: `${mutation.eventType}.prepared`,
        time: this.now().toISOString(),
        commandId: mutation.input.commandId,
        data: {
          argumentHash: hash,
          preimageEtag,
          targetEtag,
          targetContent,
          outcome,
        },
      }], workspace.module.absPath);
      prepared = appended[0];
    }
    try {
      await mutation.applyFiles?.();
      await atomicWrite(
        join(workspace.module.absPath, "README.md"),
        targetContent,
        workspace.module.absPath,
      );
      await this.appendWorkspaceCommit(mutation, prepared!, hash, outcome);
      return command.replay.kind === "prepared" ? { ...outcome, replayed: true } : outcome;
    } catch (error) {
      const current = await fileEtag(
        join(workspace.module.absPath, "README.md"),
        workspace.module.absPath,
      ).catch((readError) => isNotFound(readError) ? null : undefined);
      if (current === preimageEtag && prepared) {
        await appendEvents(command.path, [{
          source: prepared.source,
          type: prepared.type.replace(/\.prepared$/u, ".aborted"),
          time: this.now().toISOString(),
          commandId: mutation.input.commandId,
          data: {
            argumentHash: hash,
            reason: error instanceof Error ? error.message : "Workspace mutation failed.",
          },
        }], workspace.module.absPath);
      }
      throw error;
    }
  }

  private async appendWorkspaceCommit(
    mutation: {
      workspace: Omit<ResolvedWorkspace, "readme"> & { readme?: ResolvedWorkspace["readme"] };
      input: WorkspaceCreateInput | WorkspaceUpdateInput;
      command: WorkspaceMutationContext;
      eventType: string;
    },
    prepared: WorkspaceEvent,
    hash: string,
    outcome: WorkspaceMutationResult,
  ): Promise<void> {
    await appendEvents(mutation.command.path, [{
      source: prepared.source,
      type: prepared.type.replace(/\.prepared$/u, ".committed"),
      time: this.now().toISOString(),
      commandId: mutation.input.commandId,
      data: { argumentHash: hash, outcome },
    }], mutation.workspace.module.absPath);
  }

  private requireEtag(project: ProjectRecord, expected: string): void {
    if (project.etag !== expected) {
      throw new OkhError(
        "CONFLICT",
        `Project changed since it was read (expected ${expected}, current ${project.etag}).`,
        "Call workspace get and reconsider the mutation.",
      );
    }
  }

  private activityEntry(event: WorkspaceEvent): WorkspaceActivityEntry {
    const type = event.type
      .replace(/^dev\.okh\.workspace\./u, "")
      .replace(/\.committed$/u, "");
    const runId = event.subject?.match(/^runs\/(.+)$/u)?.[1];
    const checkpoint = isRecord(event.data.checkpoint) ? event.data.checkpoint : undefined;
    const reason = typeof event.data.reason === "string" ? event.data.reason : undefined;
    const guidance = typeof event.data.guidance === "string" ? event.data.guidance : undefined;
    const resultPath = typeof event.data.resultPath === "string" ? event.data.resultPath : undefined;
    const summaries: Record<string, string> = {
      "project.created": "Project created.",
      "project.updated": "Project settings updated.",
      "project.archived": "Project archived.",
      "project.unarchived": "Project unarchived.",
      "result.restored": "A prior result was restored.",
      "run.started": "Run started.",
      "run.paused": typeof checkpoint?.summary === "string"
        ? checkpoint.summary
        : "Run paused for human input.",
      "run.guided": "Human guidance recorded.",
      "run.succeeded": "Run succeeded and published a result.",
      "run.failed": "Run failed.",
      "run.cancelled": "Run cancelled.",
    };
    return {
      sequence: event.sequence,
      time: event.time,
      type,
      ...(runId ? { runId } : {}),
      summary: summaries[type] ?? type,
      ...(typeof checkpoint?.question === "string" ? { question: checkpoint.question } : {}),
      ...(reason ? { reason } : {}),
      ...(resultPath ? { resultPath } : {}),
      ...(guidance ? { guidance } : {}),
    };
  }

  private assertTransactionAvailable(
    events: readonly WorkspaceEvent[],
    replay: ReturnType<typeof commandReplay>,
  ): void {
    if (replay.kind !== "none") return;
    const pending = pendingTransaction(events);
    if (pending) {
      throw new OkhError(
        "CONFLICT",
        `Project has an unfinished "${pending.type}" transaction.`,
        `Retry command ${pending.okhcommandid} before starting another mutation.`,
      );
    }
  }

  private mutationTime(prepared: WorkspaceEvent | undefined): string {
    const outcome = prepared?.data.outcome;
    if (isRecord(outcome) && isRecord(outcome.project) && typeof outcome.project.updatedAt === "string") {
      return outcome.project.updatedAt;
    }
    return this.now().toISOString();
  }

  private preparedCommitData(prepared: WorkspaceEvent | undefined): Record<string, unknown> {
    if (!prepared) return {};
    const value = prepared.data.commitData;
    if (!isRecord(value)) {
      throw new OkhError("INVALID_MANIFEST", "Prepared workspace event has no commit data.");
    }
    return value;
  }

  private preparedOutcome(prepared: WorkspaceEvent): WorkspaceMutationResult {
    const value = prepared.data.outcome;
    if (!isRecord(value) || !isRecord(value.project) || typeof value.project.content !== "string") {
      throw new OkhError("INVALID_MANIFEST", "Prepared workspace event has no recoverable outcome.");
    }
    return value as unknown as WorkspaceMutationResult;
  }

  private async commitProjectMutation(mutation: ProjectMutation): Promise<WorkspaceMutationResult> {
    const path = projectEventsPath(mutation.workspace.module.absPath, mutation.project.id);
    const hash = argumentHash(mutation.input);
    const replay = commandReplay(mutation.events, mutation.input.commandId, hash);
    if (replay.kind === "committed") return replay.outcome!;
    this.assertTransactionAvailable(mutation.events, replay);
    let outcome = mutation.outcome;
    let targetContent = mutation.targetContent;
    let targetEtag = sha256(targetContent);
    let preparedEvent = replay.prepared;
    let preimageEtag = mutation.project.etag;
    if (replay.kind === "prepared") {
      outcome = this.preparedOutcome(replay.prepared!);
      targetContent = outcome.project!.content;
      targetEtag = typeof replay.prepared!.data.targetEtag === "string"
        ? replay.prepared!.data.targetEtag
        : sha256(targetContent);
      if (sha256(targetContent) !== targetEtag) {
        throw new OkhError("INVALID_MANIFEST", "Prepared workspace target content does not match its hash.");
      }
      const recordedPreimage = replay.prepared!.data.preimageEtag;
      if (typeof recordedPreimage !== "string") {
        throw new OkhError("INVALID_MANIFEST", "Prepared workspace event has no preimage ETag.");
      }
      preimageEtag = recordedPreimage;
      const current = await fileEtag(
        projectReadmePath(mutation.workspace.module.absPath, mutation.project.id),
        mutation.workspace.module.absPath,
      );
      if (current === targetEtag) {
        await this.appendCommit(path, mutation, hash, replay.prepared);
        return { ...outcome, replayed: true };
      }
      if (current !== recordedPreimage) {
        throw new OkhError("CONFLICT", "Prepared workspace mutation conflicts with current project state.");
      }
    } else {
      const appended = await appendEvents(path, [{
        source: sourceFor(
          mutation.workspace.target.name,
          mutation.workspace.module.path,
          mutation.project.id,
        ),
        type: `${mutation.eventType}.prepared`,
        ...(mutation.subject ? { subject: mutation.subject } : {}),
        time: this.now().toISOString(),
        commandId: mutation.input.commandId,
        data: {
          argumentHash: hash,
          preimageEtag: mutation.project.etag,
          targetEtag,
          commitData: mutation.commitData,
          outcome: mutation.outcome,
        },
      }], mutation.workspace.module.absPath);
      preparedEvent = appended[0];
    }
    try {
      await mutation.applyFiles?.();
      await atomicWrite(
        projectReadmePath(mutation.workspace.module.absPath, mutation.project.id),
        targetContent,
        mutation.workspace.module.absPath,
      );
      await this.appendCommit(path, mutation, hash, preparedEvent);
      return replay.kind === "prepared" ? { ...outcome, replayed: true } : outcome;
    } catch (error) {
      const current = await fileEtag(
        projectReadmePath(mutation.workspace.module.absPath, mutation.project.id),
        mutation.workspace.module.absPath,
      ).catch(() => undefined);
      if (current === preimageEtag && preparedEvent) {
        await appendEvents(path, [{
          source: preparedEvent.source,
          type: preparedEvent.type.replace(/\.prepared$/u, ".aborted"),
          ...(preparedEvent.subject ? { subject: preparedEvent.subject } : {}),
          time: this.now().toISOString(),
          commandId: mutation.input.commandId,
          data: {
            argumentHash: hash,
            reason: error instanceof Error ? error.message : "Workspace mutation failed.",
          },
        }], mutation.workspace.module.absPath);
      }
      throw error;
    }
  }

  private async appendCommit(
    path: string,
    mutation: ProjectMutation,
    hash: string,
    prepared?: WorkspaceEvent,
  ): Promise<void> {
    const commitData = prepared ? this.preparedCommitData(prepared) : mutation.commitData;
    const outcome = prepared ? this.preparedOutcome(prepared) : mutation.outcome;
    await appendEvents(path, [{
      source: prepared?.source ?? sourceFor(
          mutation.workspace.target.name,
          mutation.workspace.module.path,
          mutation.project.id,
        ),
      type: prepared
        ? prepared.type.replace(/\.prepared$/u, ".committed")
        : `${mutation.eventType}.committed`,
      ...((prepared?.subject ?? mutation.subject)
        ? { subject: prepared?.subject ?? mutation.subject }
        : {}),
      time: this.now().toISOString(),
      commandId: mutation.input.commandId,
      data: {
        argumentHash: hash,
        ...commitData,
        outcome,
      },
    }], mutation.workspace.module.absPath);
  }

  private startEvent(events: readonly WorkspaceEvent[], runId: string): WorkspaceEvent {
    const event = events.find(
      (candidate) =>
        candidate.subject === `runs/${runId}`
        && candidate.type === "dev.okh.workspace.run.started.committed",
    );
    if (!event) throw new OkhError("INVALID_MANIFEST", `Run "${runId}" has no committed start event.`);
    return event;
  }

  private validateEvidence(
    criteria: readonly AcceptanceCriterion[],
    evidence: readonly CriterionEvidence[],
  ): void {
    const required = new Set(criteria.map((criterion) => criterion.id));
    const covered = new Set<string>();
    for (const entry of evidence) {
      if (!required.has(entry.criterion)) {
        throw new OkhError("INVALID_ARGUMENT", `Evidence references unknown criterion "${entry.criterion}".`);
      }
      if (covered.has(entry.criterion)) {
        throw new OkhError("INVALID_ARGUMENT", `Criterion "${entry.criterion}" has duplicate evidence.`);
      }
      if (
        !Array.isArray(entry.references)
        || entry.references.length === 0
        || entry.references.some((reference) => !reference.trim())
      ) {
        throw new OkhError(
          "INVALID_ARGUMENT",
          `Criterion "${entry.criterion}" requires at least one non-empty evidence reference.`,
        );
      }
      covered.add(entry.criterion);
    }
    const missing = criteria.filter((criterion) => !covered.has(criterion.id));
    if (missing.length > 0) {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Successful report lacks evidence for: ${missing.map((criterion) => criterion.id).join(", ")}.`,
      );
    }
  }

  private async assertResultIntact(
    workspace: ResolvedWorkspace,
    project: ProjectRecord,
    result: ResultRecord,
  ): Promise<void> {
    const expectedPath = `runs/${result.runId}/result`;
    if (result.path !== expectedPath) {
      throw new OkhError("INVALID_MANIFEST", `Run "${result.runId}" has an unsafe result path.`);
    }
    const path = safeJoin(projectDirectory(workspace.module.absPath, project.id), result.path);
    const inspected = await inspectResultTree(path, workspace.module.absPath);
    if (inspected.treeHash !== result.treeHash) {
      throw new OkhError("CONFLICT", `Result for run "${result.runId}" no longer matches its recorded hash.`);
    }
  }

  private async resumeFromEvents(
    workspace: ResolvedWorkspace,
    project: ProjectRecord,
    events: readonly WorkspaceEvent[],
    runId: string,
  ): Promise<ResumePackage> {
    const start = this.startEvent(events, runId);
    const profiles = await this.profilesFromStart(workspace, project.id, start);
    const history = runHistory(events, runId);
    const snapshot = Array.isArray(start.data.snapshot)
      ? start.data.snapshot as ResumePackage["snapshot"]
      : [];
    await this.assertSnapshotIntact(workspace, project.id, runId, snapshot);
    const criteria = Array.isArray(start.data.criteria)
      ? start.data.criteria as AcceptanceCriterion[]
      : [];
    const stagingPath = typeof start.data.stagingPath === "string"
      ? start.data.stagingPath
      : stagingDirectory(this.paths, workspace.target.name, workspace.module.path, project.id, runId);
    const currentResult = start.data.currentResult && typeof start.data.currentResult === "object"
      ? start.data.currentResult as ResumePackage["currentResult"]
      : null;
    return this.buildResumePackage({
      workspace,
      project,
      runId,
      snapshot,
      currentResult,
      criteria,
      profiles,
      stagingPath,
      checkpoint: history.checkpoint,
      guidance: history.guidance,
    });
  }

  private async assertSnapshotIntact(
    workspace: ResolvedWorkspace,
    projectId: string,
    runId: string,
    recorded: ResumePackage["snapshot"],
  ): Promise<void> {
    const actual = await this.snapshotEntries(workspace, projectId, runId);
    const normalized = (entries: ResumePackage["snapshot"]) => entries
      .map(({ uri, sha256: hash }) => ({ uri, sha256: hash }))
      .sort((left, right) => left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0);
    if (canonicalJson(normalized(actual)) !== canonicalJson(normalized(recorded))) {
      throw new OkhError("CONFLICT", `Run "${runId}" snapshot no longer matches its recorded hashes.`);
    }
  }

  private buildResumePackage(input: {
    workspace: ResolvedWorkspace;
    project: ProjectRecord;
    runId: string;
    snapshot: ResumePackage["snapshot"];
    currentResult: ResultRecord | ResumePackage["currentResult"] | null;
    criteria: AcceptanceCriterion[];
    profiles: PreparedProfile[];
    stagingPath: string;
    checkpoint: ResumePackage["checkpoint"];
    guidance: ResumePackage["guidance"];
  }): ResumePackage {
    const currentResult = input.currentResult
      ? (() => {
          const path = "path" in input.currentResult ? input.currentResult.path : undefined;
          const files = Array.isArray(input.currentResult.files)
            ? input.currentResult.files.map((file) => ({
                path: file.path,
                size: file.size,
                sha256: file.sha256,
                uri: "uri" in file && typeof file.uri === "string"
                  ? file.uri
                  : moduleFileUri(
                      input.workspace.target.name,
                      input.workspace.module.path,
                      `projects/${input.project.id}/${path}/${file.path}`,
                    ),
              }))
            : undefined;
          return {
            runId: input.currentResult.runId,
            treeHash: input.currentResult.treeHash,
            ...(files && files.length > 0 ? { files } : {}),
            ...(files?.length === 1
              ? { uri: files[0]!.uri }
              : !path
                && "uri" in input.currentResult
                && input.currentResult.uri
                ? { uri: input.currentResult.uri }
                : {}),
          };
        })()
      : null;
    const lead = input.profiles.find((profile) => profile.role === "lead");
    if (!lead) throw new OkhError("INVALID_MANIFEST", "Run snapshot has no lead profile.");
    return {
      runId: input.runId,
      stagingPath: input.stagingPath,
      snapshot: input.snapshot,
      currentResult,
      criteria: input.criteria,
      checkpoint: input.checkpoint,
      guidance: input.guidance,
      profiles: {
        lead: lead.frozen,
        pool: input.profiles.filter((profile) => profile.role === "pool").map((profile) => profile.frozen),
      },
      reportContract: outputContract(),
    };
  }

  private async prepareSnapshot(
    workspace: ResolvedWorkspace,
    project: ProjectRecord,
    runId: string,
    profiles: PreparedProfile[],
    recovering: boolean,
  ): Promise<ResumePackage["snapshot"]> {
    const runRoot = join(projectRunsPath(workspace.module.absPath, project.id), runId);
    const root = join(runRoot, "snapshot");
    const rootExists = await lstat(root).then(() => true).catch((error) => {
      if (isNotFound(error)) return false;
      throw error;
    });
    if (recovering && rootExists) {
      await assertSafePath(workspace.module.absPath, root, { requireDirectory: true });
      const entries = await this.snapshotEntries(workspace, project.id, runId);
      if (entries.length > 0) return entries;
    }
    await removeSafeTree(workspace.module.absPath, runRoot);
    await ensureSafeDirectory(workspace.module.absPath, join(root, "agents"));
    const sources = [
      {
        kind: "manifest",
        source: moduleManifestPath(workspace.module.absPath),
        destination: join(root, "module.yaml"),
        relative: "module.yaml",
      },
      {
        kind: "workspace",
        source: join(workspace.module.absPath, "README.md"),
        destination: join(root, "workspace.md"),
        relative: "workspace.md",
      },
      {
        kind: "project",
        source: projectReadmePath(workspace.module.absPath, project.id),
        destination: join(root, "project.md"),
        relative: "project.md",
      },
    ];
    const snapshot: ResumePackage["snapshot"] = [];
    for (const source of sources) {
      const hash = await copySnapshotFile(
        source.source,
        source.destination,
        workspace.module.absPath,
        workspace.module.absPath,
      );
      snapshot.push({
        kind: source.kind,
        uri: moduleFileUri(
          workspace.target.name,
          workspace.module.path,
          `projects/${project.id}/runs/${runId}/snapshot/${source.relative}`,
        ),
        sha256: hash,
      });
    }
    for (const profile of profiles) {
      const destination = join(root, ...profile.snapshotPath.split("/"));
      await atomicWrite(destination, profile.frozen.profile.content, workspace.module.absPath);
      snapshot.push({
        kind: profile.role === "lead" ? "lead" : "agent",
        uri: moduleFileUri(
          workspace.target.name,
          workspace.module.path,
          `projects/${project.id}/runs/${runId}/snapshot/${profile.snapshotPath}`,
        ),
        sha256: sha256(profile.frozen.profile.content),
      });
    }
    return snapshot;
  }

  private async snapshotEntries(
    workspace: ResolvedWorkspace,
    projectId: string,
    runId: string,
  ): Promise<ResumePackage["snapshot"]> {
    const root = join(projectRunsPath(workspace.module.absPath, projectId), runId, "snapshot");
    await assertSafePath(workspace.module.absPath, root, { requireDirectory: true });
    const entries: ResumePackage["snapshot"] = [];
    const visit = async (directory: string, prefix = ""): Promise<void> => {
      await assertSafePath(workspace.module.absPath, directory, { requireDirectory: true });
      const children = await readdir(directory, { withFileTypes: true });
      for (const entry of children.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          throw new OkhError("CONFLICT", `Run snapshot contains symbolic link "${relative}".`);
        }
        if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
        else if (entry.isFile()) {
          entries.push({
            kind: relative.startsWith("agents/") ? "agent" : basename(relative, ".md"),
            uri: moduleFileUri(
              workspace.target.name,
              workspace.module.path,
              `projects/${projectId}/runs/${runId}/snapshot/${relative}`,
            ),
            sha256: await fileEtag(join(directory, entry.name), workspace.module.absPath),
          });
        } else {
          throw new OkhError("CONFLICT", `Run snapshot contains non-regular entry "${relative}".`);
        }
      }
    };
    await visit(root);
    return entries.sort((left, right) =>
      left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0);
  }

  private async resolveProfiles(workspace: ResolvedWorkspace): Promise<PreparedProfile[]> {
    const references = [
      { role: "lead" as const, reference: workspace.config.lead },
      ...workspace.config.agents.map((reference) => ({ role: "pool" as const, reference })),
    ];
    const profiles: PreparedProfile[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of references.entries()) {
      const resolved = await this.resolveAgentReference(workspace.target.name, entry.reference);
      const canonical = `${resolved.container}/${resolved.module}/${resolved.profile.id}`.toLowerCase();
      if (seen.has(canonical)) {
        throw new OkhError("INVALID_MANIFEST", `Duplicate workspace agent reference "${entry.reference}".`);
      }
      seen.add(canonical);
      profiles.push({
        role: entry.role,
        frozen: {
          agent: {
            container: resolved.container,
            module: resolved.module,
            id: resolved.profile.id,
            description: resolved.profile.description,
          },
          requestedTools: resolved.profile.requestedTools,
          profile: {
            format: "github-copilot-agent-md",
            content: resolved.profile.content,
          },
          delegation: {
            preferredMode: "native-subagent",
            fallbackMode: "inline-parent",
          },
        },
        snapshotPath: `agents/${String(index).padStart(3, "0")}-${resolved.profile.id}.agent.md`,
      });
    }
    return profiles;
  }

  private async profilesFromStart(
    workspace: ResolvedWorkspace,
    projectId: string,
    start: WorkspaceEvent,
  ): Promise<PreparedProfile[]> {
    const runId = start.subject?.replace(/^runs\//u, "");
    if (!runId) throw new OkhError("INVALID_MANIFEST", "Run start event has no run subject.");
    return this.profilesFromRecords(workspace, projectId, runId, start.data.profiles);
  }

  private async profilesFromRecords(
    workspace: ResolvedWorkspace,
    projectId: string,
    runId: string,
    values: unknown,
  ): Promise<PreparedProfile[]> {
    if (!Array.isArray(values)) {
      throw new OkhError("INVALID_MANIFEST", "Run start event has no profile records.");
    }
    const profiles: PreparedProfile[] = [];
    for (const value of values) {
      if (!isRecord(value)) {
        throw new OkhError("INVALID_MANIFEST", "Run start event contains an invalid profile record.");
      }
      const record = value as Record<string, unknown>;
      const agent = record.agent;
      if (
        (record.role !== "lead" && record.role !== "pool")
        || !agent
        || typeof agent !== "object"
        || typeof record.snapshotPath !== "string"
      ) {
        throw new OkhError("INVALID_MANIFEST", "Run start event contains an invalid profile record.");
      }
      const identity = agent as Record<string, unknown>;
      if (
        typeof identity.container !== "string"
        || typeof identity.module !== "string"
        || typeof identity.id !== "string"
        || typeof identity.description !== "string"
      ) {
        throw new OkhError("INVALID_MANIFEST", "Run start profile identity is invalid.");
      }
      if (!record.snapshotPath.startsWith("agents/")) {
        throw new OkhError("INVALID_MANIFEST", "Run start profile snapshot path is invalid.");
      }
      const root = join(projectRunsPath(workspace.module.absPath, projectId), runId, "snapshot");
      const path = safeJoin(root, record.snapshotPath);
      const content = await readSafeTextFile(workspace.module.absPath, path);
      profiles.push({
        role: record.role,
        snapshotPath: record.snapshotPath,
        frozen: {
          agent: {
            container: identity.container,
            module: identity.module,
            id: identity.id,
            description: identity.description,
          },
          requestedTools: Array.isArray(record.requestedTools)
            ? record.requestedTools.filter((tool): tool is string => typeof tool === "string")
            : [],
          profile: { format: "github-copilot-agent-md", content },
          delegation: {
            preferredMode: "native-subagent",
            fallbackMode: "inline-parent",
          },
        },
      });
    }
    return profiles;
  }

  private async resolveAgentReference(
    currentContainer: string,
    reference: string,
  ): Promise<{ container: string; module: string; profile: AgentProfile }> {
    const parts = reference.split("/");
    if (parts.length === 3) {
      const [container, module, agent] = parts;
      return {
        container: nonBlank(container, "agent container"),
        module: nonBlank(module, "agent module"),
        profile: await this.containers.resolveAgentProfile(
          nonBlank(container, "agent container"),
          nonBlank(module, "agent module"),
          nonBlank(agent, "agent"),
        ),
      };
    }
    if (parts.length === 2) {
      const [module, agent] = parts;
      return {
        container: currentContainer,
        module: nonBlank(module, "agent module"),
        profile: await this.containers.resolveAgentProfile(
          currentContainer,
          nonBlank(module, "agent module"),
          nonBlank(agent, "agent"),
        ),
      };
    }
    if (parts.length !== 1) {
      throw new OkhError("INVALID_MANIFEST", `Invalid agent reference "${reference}".`);
    }
    const agent = nonBlank(parts[0], "agent");
    const targets = await this.containers.resolveTargets(currentContainer);
    const target = targets[0];
    if (!target) throw new OkhError("NOT_FOUND", `Container "${currentContainer}" does not exist.`);
    const matches: Array<{ module: string; profile: AgentProfile }> = [];
    for (const module of target.modules.filter((candidate) => candidate.type === "agents")) {
      try {
        matches.push({
          module: module.path,
          profile: await this.containers.resolveAgentProfile(currentContainer, module.path, agent),
        });
      } catch (error) {
        if (!isOkhError(error) || error.code !== "NOT_FOUND") throw error;
      }
    }
    if (matches.length === 0) {
      throw new OkhError("NOT_FOUND", `No agent "${agent}" exists in container "${currentContainer}".`);
    }
    if (matches.length > 1) {
      throw new OkhError(
        "CONFLICT",
        `Agent "${agent}" is ambiguous; use one of: ${matches.map((match) => `${match.module}/${agent}`).join(", ")}.`,
      );
    }
    return { container: currentContainer, module: matches[0]!.module, profile: matches[0]!.profile };
  }

  private async agentIssues(workspace: ResolvedWorkspace): Promise<string[]> {
    const issues: string[] = [];
    for (const reference of [workspace.config.lead, ...workspace.config.agents]) {
      try {
        await this.resolveAgentReference(workspace.target.name, reference);
      } catch (error) {
        issues.push(`${reference}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return issues;
  }
}
