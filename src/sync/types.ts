import type { BackendType, SyncMode, ContainerEntry } from "../registry/schema.js";

export type SyncOutcome = "synced" | "up-to-date" | "published" | "validated" | "error";

export interface SyncSelection {
  mode: SyncMode;
  config: Record<string, unknown>;
}

export interface ResolveSyncContext {
  containerName: string;
}

export interface BackendSyncRequest {
  entry: ContainerEntry;
  validation: { ok: boolean; issues: string[] };
  message?: string;
  action?: string;
}

export interface BackendSyncResult {
  mode: SyncMode;
  requestedAction?: string;
  outcome: SyncOutcome;
  committed?: boolean;
  pushed?: boolean;
  branch?: string;
  prUrl?: string;
}

export interface SyncBackend {
  readonly type: BackendType;
  readonly modes: readonly SyncMode[];
  resolveBackendConfig(config: unknown): Record<string, unknown>;
  resolveSync(selection: SyncSelection, context: ResolveSyncContext): Promise<SyncSelection>;
  actions(selection: SyncSelection): readonly string[];
  sync(request: BackendSyncRequest): Promise<BackendSyncResult>;
}
