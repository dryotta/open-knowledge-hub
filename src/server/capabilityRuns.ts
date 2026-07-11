import { randomUUID } from "node:crypto";
import {
  deriveOverallStatus,
  normalizeCapabilityProbe,
  normalizeCapabilityReport,
  type CapabilityProbe,
  type CapabilityReport,
  type ProbeKey,
} from "./capabilityReport.js";

export const DEFAULT_CAPABILITY_RUN_LIMIT = 32;
export const DEFAULT_CAPABILITY_RUN_TTL_MS = 30 * 60 * 1000;

export type CapabilityRunContext = {
  id: string;
  createdAt: string;
  expiresAt: string;
};

export type CapabilityRun = {
  id: string;
  clientKey: object;
  createdAt: string;
  expiresAt: string;
  report: CapabilityReport;
  taskId?: string;
  signal: AbortSignal;
};

export type CapabilityRunSnapshot = {
  id: string;
  createdAt: string;
  expiresAt: string;
  report: CapabilityReport;
  taskId?: string;
  aborted: boolean;
};

export type CapabilityRunErrorCode = "missing" | "expired" | "cross_client";

export class CapabilityRunStoreError extends Error {
  constructor(
    message: string,
    public readonly code: CapabilityRunErrorCode,
    public readonly runId: string,
  ) {
    super(message);
  }
}

export class CapabilityRunNotFoundError extends CapabilityRunStoreError {
  constructor(runId: string) {
    super(`Capability run '${runId}' was not found.`, "missing", runId);
    this.name = "CapabilityRunNotFoundError";
  }
}

export class CapabilityRunExpiredError extends CapabilityRunStoreError {
  constructor(
    runId: string,
    public readonly report: CapabilityReport,
  ) {
    super(`Capability run '${runId}' has expired.`, "expired", runId);
    this.name = "CapabilityRunExpiredError";
  }
}

export class CapabilityRunClientMismatchError extends CapabilityRunStoreError {
  constructor(runId: string) {
    super(`Capability run '${runId}' does not belong to this client.`, "cross_client", runId);
    this.name = "CapabilityRunClientMismatchError";
  }
}

export type CapabilityRunStoreOptions = {
  now?: () => Date;
  maxRuns?: number;
  ttlMs?: number;
  createId?: () => string;
};

const APP_PROBE_KEYS = ["appInitialize", "appTheme", "appResize"] as const satisfies readonly ProbeKey[];

const PROBE_RUNNER_KEYS = [
  "roots",
  "samplingBasic",
  "samplingTools",
  "elicitationForm",
  "elicitationUrl",
] as const satisfies readonly ProbeKey[];

function normalizeReport(report: CapabilityReport, context: CapabilityRunContext): CapabilityReport {
  return normalizeCapabilityReport(
    {
      ...report,
      schemaVersion: "1",
    },
    {
      runId: context.id,
      createdAt: context.createdAt,
      expiresAt: context.expiresAt,
    },
  );
}

type StoredCapabilityRun = Omit<CapabilityRun, "signal"> & {
  abortController: AbortController;
};

function withProbe(
  report: CapabilityReport,
  key: ProbeKey,
  probe: CapabilityProbe,
): CapabilityReport {
  const probes = {
    ...report.probes,
    [key]: probe,
  };
  return {
    ...report,
    probes,
    overallStatus: deriveOverallStatus(Object.values(probes)),
  };
}

function mergeReportPreservingTerminal(
  current: CapabilityReport,
  next: CapabilityReport,
): CapabilityReport {
  const probes = { ...next.probes };
  for (const key of Object.keys(current.probes) as ProbeKey[]) {
    if (current.probes[key].status !== "pending") {
      probes[key] = current.probes[key];
    }
  }

  return {
    ...next,
    probes,
    overallStatus: deriveOverallStatus(Object.values(probes)),
  };
}

function cloneReport(report: CapabilityReport): CapabilityReport {
  return normalizeReport(report, {
    id: report.runId,
    createdAt: report.createdAt,
    expiresAt: report.expiresAt,
  });
}

function failExpiredPendingAppProbes(report: CapabilityReport): CapabilityReport {
  const normalized = cloneReport(report);
  const probes = { ...normalized.probes };

  for (const key of APP_PROBE_KEYS) {
    if (probes[key].status === "pending") {
      probes[key] = {
        status: "failed",
        code: probes[key].code,
        message: "Probe expired before completion.",
      };
    }
  }

  return {
    ...normalized,
    probes,
    overallStatus: deriveOverallStatus(Object.values(probes)),
  };
}

function freezeCancelledPendingProbes(report: CapabilityReport): CapabilityReport {
  const normalized = cloneReport(report);
  const probes = { ...normalized.probes };

  for (const key of PROBE_RUNNER_KEYS) {
    if (probes[key].status === "pending") {
      probes[key] = {
        status: "not_exercised",
        code: probes[key].code,
        message: "Scan was cancelled before this probe completed.",
      };
    }
  }

  return {
    ...normalized,
    probes,
    overallStatus: deriveOverallStatus(Object.values(probes)),
  };
}

function toRunCopy(run: StoredCapabilityRun): CapabilityRun {
  return {
    id: run.id,
    clientKey: run.clientKey,
    createdAt: run.createdAt,
    expiresAt: run.expiresAt,
    report: cloneReport(run.report),
    ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
    signal: run.abortController.signal,
  };
}

function toSnapshot(run: StoredCapabilityRun): CapabilityRunSnapshot {
  return {
    id: run.id,
    createdAt: run.createdAt,
    expiresAt: run.expiresAt,
    report: cloneReport(run.report),
    ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
    aborted: run.abortController.signal.aborted,
  };
}

export class CapabilityRunStore {
  private readonly runs = new Map<string, StoredCapabilityRun>();
  private readonly now: () => Date;
  private readonly maxRuns: number;
  private readonly ttlMs: number;
  private readonly createId: () => string;

  constructor(options: CapabilityRunStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxRuns = options.maxRuns ?? DEFAULT_CAPABILITY_RUN_LIMIT;
    this.ttlMs = options.ttlMs ?? DEFAULT_CAPABILITY_RUN_TTL_MS;
    this.createId = options.createId ?? randomUUID;

    if (!Number.isInteger(this.maxRuns) || this.maxRuns < 1) {
      throw new TypeError("maxRuns must be a positive integer.");
    }
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 1) {
      throw new TypeError("ttlMs must be a positive number.");
    }
  }

  createRun(clientKey: object, createReport: (context: CapabilityRunContext) => CapabilityReport): CapabilityRun {
    this.pruneExpired();

    const created = this.now();
    const context = {
      id: this.nextId(),
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + this.ttlMs).toISOString(),
    };
    const run: StoredCapabilityRun = {
      id: context.id,
      clientKey,
      createdAt: context.createdAt,
      expiresAt: context.expiresAt,
      report: normalizeReport(createReport(context), context),
      abortController: new AbortController(),
    };

    this.runs.set(run.id, run);
    this.evictOverflow();
    return toRunCopy(run);
  }

  getRunForClient(clientKey: object, runId: string): CapabilityRun {
    return toRunCopy(this.requireAccessibleRun(clientKey, runId));
  }

  getSnapshotForClient(clientKey: object, runId: string): CapabilityRunSnapshot {
    return toSnapshot(this.requireAccessibleRun(clientKey, runId));
  }

  updateReport(clientKey: object, runId: string, report: CapabilityReport): CapabilityRunSnapshot {
    const run = this.requireAccessibleRun(clientKey, runId);
    run.report = mergeReportPreservingTerminal(run.report, normalizeReport(report, run));
    return toSnapshot(run);
  }

  updateProbe(clientKey: object, runId: string, key: ProbeKey, next: CapabilityProbe): CapabilityRunSnapshot {
    const run = this.requireAccessibleRun(clientKey, runId);
    if (run.report.probes[key].status === "pending") {
      run.report = withProbe(run.report, key, normalizeCapabilityProbe(next));
    }
    return toSnapshot(run);
  }

  replaceProbe(clientKey: object, runId: string, key: ProbeKey, next: CapabilityProbe): CapabilityRunSnapshot {
    const run = this.requireAccessibleRun(clientKey, runId);
    run.report = withProbe(run.report, key, normalizeCapabilityProbe(next));
    return toSnapshot(run);
  }

  associateTaskId(clientKey: object, runId: string, taskId: string): CapabilityRunSnapshot {
    const run = this.requireAccessibleRun(clientKey, runId);
    run.taskId = taskId;
    return toSnapshot(run);
  }

  abortRun(clientKey: object, runId: string): CapabilityRunSnapshot {
    const run = this.requireAccessibleRun(clientKey, runId);
    run.report = freezeCancelledPendingProbes(run.report);
    run.abortController.abort();
    return toSnapshot(run);
  }

  listSnapshots(clientKey: object): CapabilityRunSnapshot[] {
    this.pruneExpired();
    return Array.from(this.runs.values())
      .filter((run) => run.clientKey === clientKey)
      .map((run) => toSnapshot(run));
  }

  dispose(): void {
    for (const run of this.runs.values()) {
      run.abortController.abort();
    }
    this.runs.clear();
  }

  private pruneExpired(): void {
    for (const run of Array.from(this.runs.values())) {
      if (this.isExpired(run)) {
        this.expireRun(run);
      }
    }
  }

  private nextId(): string {
    let id = this.createId();
    while (this.runs.has(id)) {
      id = this.createId();
    }
    return id;
  }

  private requireAccessibleRun(clientKey: object, runId: string): StoredCapabilityRun {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new CapabilityRunNotFoundError(runId);
    }
    if (run.clientKey !== clientKey) {
      throw new CapabilityRunClientMismatchError(runId);
    }
    if (this.isExpired(run)) {
      const expired = this.expireRun(run);
      throw new CapabilityRunExpiredError(runId, expired.report);
    }
    return run;
  }

  private isExpired(run: StoredCapabilityRun): boolean {
    return this.now().getTime() >= Date.parse(run.expiresAt);
  }

  private expireRun(run: StoredCapabilityRun): CapabilityRunSnapshot {
    run.report = failExpiredPendingAppProbes(run.report);
    run.abortController.abort();
    const snapshot = toSnapshot(run);
    this.runs.delete(run.id);
    return snapshot;
  }

  private evictOverflow(): void {
    while (this.runs.size > this.maxRuns) {
      const oldest = this.runs.values().next().value as StoredCapabilityRun | undefined;
      if (oldest === undefined) return;
      oldest.abortController.abort();
      this.runs.delete(oldest.id);
    }
  }
}
