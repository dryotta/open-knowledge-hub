export const PROJECT_STATUSES = ["active", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const RUN_REPORT_STATES = ["paused", "succeeded", "failed", "cancelled"] as const;
export type RunReportState = (typeof RUN_REPORT_STATES)[number];

export interface WorkspaceConfig {
  lead: string;
  agents: string[];
}

export interface WorkspaceReadme {
  title: string;
  guidance: string;
  acceptance: string[];
  content: string;
  etag: string;
}

export interface ProjectRecord {
  id: string;
  title: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  activeRun: string | null;
  result: string | null;
  targetDate?: string;
  tags: string[];
  goal: string;
  guidance?: string;
  acceptance: string[];
  content: string;
  etag: string;
}

export interface AcceptanceCriterion {
  id: string;
  source: "workspace" | "project";
  text: string;
}

export interface ResultFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ResultRecord {
  runId: string;
  finishedAt: string;
  path: string;
  treeHash: string;
  files: ResultFile[];
  evidence: CriterionEvidence[];
}

export interface CriterionEvidence {
  criterion: string;
  references: string[];
}

export interface RunCheckpoint {
  summary: string;
  stagedPaths?: string[];
  question?: string;
  reason?: string;
}

export interface GuidanceRecord {
  time: string;
  text: string;
}

export interface FrozenAgent {
  agent: {
    container: string;
    module: string;
    id: string;
    description: string;
  };
  requestedTools: string[];
  profile: {
    format: "github-copilot-agent-md";
    content: string;
  };
  delegation: {
    preferredMode: "native-subagent";
    fallbackMode: "inline-parent";
  };
}

export interface ResumePackage {
  runId: string;
  stagingPath: string;
  snapshot: Array<{ kind: string; uri: string; sha256: string }>;
  currentResult: {
    runId: string;
    treeHash: string;
    uri?: string;
    files?: Array<ResultFile & { uri: string }>;
  } | null;
  criteria: AcceptanceCriterion[];
  checkpoint: RunCheckpoint | null;
  guidance: GuidanceRecord[];
  profiles: {
    lead: FrozenAgent;
    pool: FrozenAgent[];
  };
  reportContract: {
    states: RunReportState[];
    requiredByState: Record<RunReportState, string[]>;
    outputLimits: {
      maxFiles: number;
      maxFileBytes: number;
      maxTotalBytes: number;
    };
  };
}

export interface AttentionSummary {
  kind: "paused";
  summary: string;
  question?: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  targetDate?: string;
  tags: string[];
  activeRun: string | null;
  currentResult: Pick<ResultRecord, "runId" | "path" | "treeHash"> | null;
  attention: AttentionSummary | null;
}

export interface WorkspaceActivityEntry {
  sequence: number;
  time: string;
  type: string;
  runId?: string;
  summary: string;
  question?: string;
  reason?: string;
  resultPath?: string;
  guidance?: string;
}

export interface WorkspaceListInput {
  operation: "list";
  container: string;
  module: string;
  status?: ProjectStatus | "all";
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
}

export interface WorkspaceGetInput {
  operation: "get";
  container: string;
  module: string;
  project?: string;
  include?: Array<"resume" | "results">;
}

export interface WorkspaceCreateInput {
  operation: "create";
  container: string;
  module: string;
  project?: string;
  title?: string;
  goal?: string;
  guidance?: string;
  acceptance?: string[];
  targetDate?: string;
  tags?: string[];
  commandId: string;
}

export interface WorkspaceStartInput {
  operation: "start";
  container: string;
  module: string;
  project: string;
  correction?: string;
  etag: string;
  commandId: string;
}

export interface WorkspaceReportInput {
  operation: "report";
  container: string;
  module: string;
  project: string;
  run: string;
  state: RunReportState;
  checkpoint?: RunCheckpoint;
  resultPath?: string;
  evidence?: CriterionEvidence[];
  reason?: string;
  etag: string;
  commandId: string;
}

export interface WorkspacePatch {
  guidance?: string | null;
  acceptance?: string[];
  title?: string;
  goal?: string;
  targetDate?: string | null;
  tags?: string[];
}

export interface WorkspaceUpdateInput {
  operation: "update";
  container: string;
  module: string;
  project?: string;
  patch?: WorkspacePatch;
  action?: "archive" | "unarchive" | "restore";
  fromRun?: string;
  etag: string;
  commandId: string;
}

export interface WorkspaceInterveneInput {
  operation: "intervene";
  container: string;
  module: string;
  project: string;
  run: string;
  action: "guide" | "cancel";
  guidance?: string;
  reason?: string;
  etag: string;
  commandId: string;
}

export type WorkspaceInput =
  | WorkspaceListInput
  | WorkspaceGetInput
  | WorkspaceCreateInput
  | WorkspaceStartInput
  | WorkspaceReportInput
  | WorkspaceUpdateInput
  | WorkspaceInterveneInput;

export interface WorkspaceEvent {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  subject?: string;
  time: string;
  datacontenttype: "application/json";
  sequence: number;
  okhcommandid: string;
  data: Record<string, unknown>;
}

export interface WorkspaceListResult {
  projects: ProjectSummary[];
  nextCursor: string | null;
}

export interface WorkspaceGetResult {
  workspace?: {
    container: string;
    module: string;
    description: string;
    guidance: string;
    acceptance: string[];
    lead: string;
    agents: string[];
    agentHealth: "valid" | "invalid";
    agentIssues: string[];
  };
  counts?: {
    active: number;
    archived: number;
    activeRuns: number;
    attention: number;
  };
  project?: ProjectRecord;
  resume?: ResumePackage | null;
  results?: ResultRecord[];
  etag: string;
  validActions: string[];
}

export interface WorkspaceMutationResult extends WorkspaceGetResult {
  replayed?: boolean;
}

export type WorkspaceResult =
  | WorkspaceListResult
  | WorkspaceGetResult
  | WorkspaceMutationResult;
