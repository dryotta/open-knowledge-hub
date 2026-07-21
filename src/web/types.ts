import type { BackendType, SyncDescriptor } from "../registry/schema.js";
import type {
  ProjectSummary,
  WorkspaceActivityEntry,
  WorkspaceGetResult,
  WorkspaceMutationResult,
} from "../workspaces/types.js";

export interface WebModuleSummary {
  path: string;
  type: string;
}

export interface WebContainerSummary {
  name: string;
  backend: BackendType;
  sync?: SyncDescriptor;
  syncActions?: string[];
  moduleCount: number;
  modules: WebModuleSummary[];
  manifestValid: boolean;
  localPath: string;
}

export interface WebContainersResponse {
  containers: WebContainerSummary[];
}

export interface WebFileEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size?: number;
}

export interface WebDirectoryResponse {
  container: string;
  module: string;
  path: string;
  entries: WebFileEntry[];
}

export interface WebFileResponse {
  container: string;
  module: string;
  path: string;
  content: string;
  size: number;
}

export interface WebWorkspaceSummary {
  container: string;
  module: string;
  description: string;
  sync?: SyncDescriptor;
  counts?: {
    active: number;
    archived: number;
    activeRuns: number;
    attention: number;
  };
  nearestTargetDate?: string;
  agentHealth?: "valid" | "invalid";
  issue?: string;
}

export interface WebWorkspacesResponse {
  workspaces: WebWorkspaceSummary[];
}

export interface WebWorkspaceDetailResponse {
  detail: WorkspaceGetResult;
  projects: ProjectSummary[];
  sync?: SyncDescriptor;
}

export interface WebProjectDetailResponse {
  detail: WorkspaceGetResult;
  activity: WorkspaceActivityEntry[];
}

export interface WebAttentionEntry {
  container: string;
  module: string;
  project: ProjectSummary;
  detail: WorkspaceGetResult;
}

export interface WebAttentionResponse {
  entries: WebAttentionEntry[];
}

export interface WebAgentSummary {
  container: string;
  module: string;
  id: string;
  description: string;
  path: string;
  referencedBy: Array<{
    container: string;
    module: string;
    role: "lead" | "pool";
  }>;
}

export interface WebAgentsResponse {
  agents: WebAgentSummary[];
  issues: string[];
}

export type WebWorkspaceMutationResponse = WorkspaceMutationResult;

export interface WebErrorResponse {
  error: {
    code: string;
    message: string;
    hint?: string;
  };
}
