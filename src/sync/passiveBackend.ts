import { z } from "zod";
import { OkhError } from "../errors.js";
import type { SyncMode } from "../registry/schema.js";
import type {
  SyncBackend,
  SyncSelection,
  ResolveSyncContext,
  BackendSyncRequest,
  BackendSyncResult,
} from "./types.js";

const emptyConfigSchema = z.object({}).strict();

type PassiveBackendType = "local" | "onedrive";

export class PassiveBackend implements SyncBackend {
  readonly type: PassiveBackendType;
  readonly modes: readonly SyncMode[] = ["auto"];

  constructor(type: PassiveBackendType) {
    this.type = type;
  }

  resolveBackendConfig(config: unknown): Record<string, unknown> {
    const result = emptyConfigSchema.safeParse(config);
    if (!result.success) {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Backend config for "${this.type}" must be empty: ${result.error.issues[0]?.message ?? result.error.message}`,
      );
    }
    return {};
  }

  async resolveSync(selection: SyncSelection, _context: ResolveSyncContext): Promise<SyncSelection> {
    if (selection.mode !== "auto") {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Backend "${this.type}" only supports sync mode "auto", got "${selection.mode}"`,
      );
    }
    const result = emptyConfigSchema.safeParse(selection.config);
    if (!result.success) {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Sync config for "${this.type}" must be empty: ${result.error.issues[0]?.message ?? result.error.message}`,
      );
    }
    return { mode: "auto", config: {} };
  }

  actions(_selection: SyncSelection): readonly string[] {
    return [];
  }

  async sync(request: BackendSyncRequest): Promise<BackendSyncResult> {
    if (request.action !== undefined) {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Backend "${this.type}" does not support actions, got "${request.action}"`,
      );
    }
    return { mode: "auto", outcome: "validated" };
  }
}
