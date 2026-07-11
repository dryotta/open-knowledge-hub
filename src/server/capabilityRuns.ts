import { randomUUID } from "node:crypto";
import {
  deriveOverallStatus,
  type CapabilityEvidence,
  type CapabilityEvidenceCategory,
  type CapabilityProbe,
  type CapabilityReport,
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
  abortController: AbortController;
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

type ProbeKey = keyof CapabilityReport["probes"];

const APP_PROBE_KEYS = ["appInitialize", "appTheme", "appResize"] as const satisfies readonly ProbeKey[];
const COUNT_MIN = 0;
const COUNT_MAX = 1_000;
const DURATION_MIN_MS = 0;
const DURATION_MAX_MS = 60_000;

function clampFiniteInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.trunc(value);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}

function isCapabilityEvidenceCategory(value: unknown): value is CapabilityEvidenceCategory {
  return (
    value === "advertised" ||
    value === "observed" ||
    value === "exercised" ||
    value === "unsupported"
  );
}

function sanitizeEvidence(evidence: CapabilityEvidence | undefined): CapabilityEvidence | undefined {
  if (evidence === undefined) return undefined;

  const candidate = evidence as { kind?: unknown; value?: unknown };
  switch (candidate.kind) {
    case "count": {
      const value = clampFiniteInteger(candidate.value, COUNT_MIN, COUNT_MAX);
      return value === undefined ? undefined : { kind: "count", value };
    }
    case "durationMs": {
      const value = clampFiniteInteger(candidate.value, DURATION_MIN_MS, DURATION_MAX_MS);
      return value === undefined ? undefined : { kind: "durationMs", value };
    }
    case "flag":
      return typeof candidate.value === "boolean" ? { kind: "flag", value: candidate.value } : undefined;
    case "category":
      return isCapabilityEvidenceCategory(candidate.value) ? { kind: "category", value: candidate.value } : undefined;
    default:
      return undefined;
  }
}

function normalizeProbe(probe: CapabilityProbe): CapabilityProbe {
  const evidence = sanitizeEvidence(probe.evidence);
  return evidence === undefined
    ? {
        status: probe.status,
        code: probe.code,
        message: probe.message,
      }
    : {
        status: probe.status,
        code: probe.code,
        message: probe.message,
        evidence,
      };
}

function normalizeReport(report: CapabilityReport, context: CapabilityRunContext): CapabilityReport {
  const probes: CapabilityReport["probes"] = {
    roots: normalizeProbe(report.probes.roots),
    samplingBasic: normalizeProbe(report.probes.samplingBasic),
    samplingTools: normalizeProbe(report.probes.samplingTools),
    elicitationForm: normalizeProbe(report.probes.elicitationForm),
    elicitationUrl: normalizeProbe(report.probes.elicitationUrl),
    appInitialize: normalizeProbe(report.probes.appInitialize),
    appTheme: normalizeProbe(report.probes.appTheme),
    appResize: normalizeProbe(report.probes.appResize),
    tasksCreate: normalizeProbe(report.probes.tasksCreate),
    tasksPoll: normalizeProbe(report.probes.tasksPoll),
    tasksInput: normalizeProbe(report.probes.tasksInput),
    tasksResult: normalizeProbe(report.probes.tasksResult),
    tasksCancel: normalizeProbe(report.probes.tasksCancel),
  };

  return {
    schemaVersion: "1",
    runId: context.id,
    createdAt: context.createdAt,
    expiresAt: context.expiresAt,
    testedProtocolGeneration: report.testedProtocolGeneration,
    client: {
      declared: {
        roots: report.client.declared.roots,
        rootsListChanged: report.client.declared.rootsListChanged,
        sampling: report.client.declared.sampling,
        samplingTools: report.client.declared.samplingTools,
        elicitationForm: report.client.declared.elicitationForm,
        elicitationUrl: report.client.declared.elicitationUrl,
        tasks: report.client.declared.tasks,
      },
    },
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
  const probes: CapabilityReport["probes"] = {
    roots: normalizeProbe(report.probes.roots),
    samplingBasic: normalizeProbe(report.probes.samplingBasic),
    samplingTools: normalizeProbe(report.probes.samplingTools),
    elicitationForm: normalizeProbe(report.probes.elicitationForm),
    elicitationUrl: normalizeProbe(report.probes.elicitationUrl),
    appInitialize: normalizeProbe(report.probes.appInitialize),
    appTheme: normalizeProbe(report.probes.appTheme),
    appResize: normalizeProbe(report.probes.appResize),
    tasksCreate: normalizeProbe(report.probes.tasksCreate),
    tasksPoll: normalizeProbe(report.probes.tasksPoll),
    tasksInput: normalizeProbe(report.probes.tasksInput),
    tasksResult: normalizeProbe(report.probes.tasksResult),
    tasksCancel: normalizeProbe(report.probes.tasksCancel),
  };

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
    ...cloneReport(report),
    probes,
    overallStatus: deriveOverallStatus(Object.values(probes)),
  };
}

function toRunCopy(run: CapabilityRun): CapabilityRun {
  return {
    id: run.id,
    clientKey: run.clientKey,
    createdAt: run.createdAt,
    expiresAt: run.expiresAt,
    report: cloneReport(run.report),
    ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
    abortController: run.abortController,
  };
}

function toSnapshot(run: CapabilityRun): CapabilityRunSnapshot {
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
  private readonly runs = new Map<string, CapabilityRun>();
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
    const run: CapabilityRun = {
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
    run.report = normalizeReport(report, run);
    return toSnapshot(run);
  }

  associateTaskId(clientKey: object, runId: string, taskId: string): CapabilityRunSnapshot {
    const run = this.requireAccessibleRun(clientKey, runId);
    run.taskId = taskId;
    return toSnapshot(run);
  }

  abortRun(clientKey: object, runId: string): CapabilityRunSnapshot {
    const run = this.requireAccessibleRun(clientKey, runId);
    run.abortController.abort();
    return toSnapshot(run);
  }

  listSnapshots(clientKey: object): CapabilityRunSnapshot[] {
    this.pruneExpired();
    return Array.from(this.runs.values())
      .filter((run) => run.clientKey === clientKey)
      .map((run) => toSnapshot(run));
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

  private requireAccessibleRun(clientKey: object, runId: string): CapabilityRun {
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

  private isExpired(run: CapabilityRun): boolean {
    return this.now().getTime() >= Date.parse(run.expiresAt);
  }

  private expireRun(run: CapabilityRun): CapabilityRunSnapshot {
    run.report = failExpiredPendingAppProbes(run.report);
    run.abortController.abort();
    const snapshot = toSnapshot(run);
    this.runs.delete(run.id);
    return snapshot;
  }

  private evictOverflow(): void {
    while (this.runs.size > this.maxRuns) {
      const oldest = this.runs.values().next().value as CapabilityRun | undefined;
      if (oldest === undefined) return;
      oldest.abortController.abort();
      this.runs.delete(oldest.id);
    }
  }
}
