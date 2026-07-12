import type { BackendType, SyncDescriptor } from "../registry/schema.js";

export interface WebModuleSummary {
  path: string;
  type: string;
  name: string;
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

export interface WebErrorResponse {
  error: {
    code: string;
    message: string;
    hint?: string;
  };
}
