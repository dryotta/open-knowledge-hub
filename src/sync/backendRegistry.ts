import { OkhError } from "../errors.js";
import type { BackendType, ContainerEntry } from "../registry/schema.js";
import type { SyncBackend, SyncSelection, ResolveSyncContext } from "./types.js";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortKeys(nested)]),
  );
}

/** Stable JSON serialization independent of key insertion order. */
function stableStringify(value: Record<string, unknown>): string {
  return JSON.stringify(sortKeys(value));
}

export class BackendRegistry {
  private readonly adapters: ReadonlyMap<BackendType, SyncBackend>;

  constructor(backends: readonly SyncBackend[]) {
    const map = new Map<BackendType, SyncBackend>();
    for (const backend of backends) {
      if (map.has(backend.type)) {
        throw new OkhError(
          "INVALID_ARGUMENT",
          `Duplicate backend type registered: "${backend.type}"`,
        );
      }
      map.set(backend.type, backend);
    }
    this.adapters = map;
  }

  require(type: BackendType): SyncBackend {
    const backend = this.adapters.get(type);
    if (!backend) {
      const supported = [...this.adapters.keys()].join(", ");
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Unknown backend type "${type}". Supported: ${supported}`,
      );
    }
    return backend;
  }

  resolveBackendConfig(type: BackendType, config: unknown): Record<string, unknown> {
    return this.require(type).resolveBackendConfig(config);
  }

  async resolveSync(
    type: BackendType,
    selection: SyncSelection,
    context: ResolveSyncContext,
  ): Promise<SyncSelection> {
    const backend = this.require(type);
    if (!backend.modes.includes(selection.mode)) {
      const supported = [...backend.modes].join(", ");
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Backend "${type}" does not support sync mode "${selection.mode}". Supported: ${supported}`,
      );
    }
    return backend.resolveSync(selection, context);
  }

  actions(entry: ContainerEntry): readonly string[];
  actions(type: BackendType, selection: SyncSelection): readonly string[];
  actions(
    entryOrType: ContainerEntry | BackendType,
    selection?: SyncSelection,
  ): readonly string[] {
    if (typeof entryOrType !== "string") {
      return this.require(entryOrType.backend.type).actions({
        mode: entryOrType.sync.mode,
        config: entryOrType.sync.config,
      });
    }
    if (selection === undefined) {
      throw new OkhError("INVALID_ARGUMENT", "selection is required when type is provided");
    }
    return this.require(entryOrType).actions(selection);
  }

  async validateEntry(entry: ContainerEntry): Promise<void> {
    const backend = this.require(entry.backend.type);

    // Validate backend config — throws for unknown keys or invalid values.
    backend.resolveBackendConfig(entry.backend.config);

    // Validate sync mode is supported by this backend.
    if (!backend.modes.includes(entry.sync.mode)) {
      const supported = [...backend.modes].join(", ");
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Backend "${entry.backend.type}" does not support sync mode "${entry.sync.mode}". Supported: ${supported}`,
      );
    }

    // Validate sync config strictly; compare normalized output to input so that
    // persisted entries with unapplied defaults or mode coercions are caught.
    const selection: SyncSelection = { mode: entry.sync.mode, config: entry.sync.config };
    const resolved = await backend.resolveSync(selection, { containerName: entry.name });

    if (
      resolved.mode !== entry.sync.mode ||
      stableStringify(resolved.config) !== stableStringify(entry.sync.config)
    ) {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Persisted sync config for "${entry.backend.type}" container "${entry.name}" has inconsistent values. Re-add or update the container to fix.`,
      );
    }
  }

  async validateEntries(entries: ContainerEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.validateEntry(entry);
    }
  }
}
