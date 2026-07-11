import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ProbeStatus =
  | "passed"
  | "supported_not_completed"
  | "advertised_only"
  | "unsupported"
  | "failed"
  | "pending"
  | "not_exercised";

export type CapabilityEvidenceCategory =
  | "advertised"
  | "observed"
  | "exercised"
  | "unsupported";

export type CapabilityEvidence =
  | { kind: "count"; value: number }
  | { kind: "durationMs"; value: number }
  | { kind: "flag"; value: boolean }
  | { kind: "category"; value: CapabilityEvidenceCategory };

export type CapabilityProbe = {
  status: ProbeStatus;
  code: string;
  message: string;
  evidence?: CapabilityEvidence;
};

export type CapabilityReport = {
  schemaVersion: "1";
  runId: string;
  createdAt: string;
  expiresAt: string;
  testedProtocolGeneration: string;
  client: {
    declared: {
      roots: boolean;
      rootsListChanged: boolean;
      sampling: boolean;
      samplingTools: boolean;
      elicitationForm: boolean;
      elicitationUrl: boolean;
      tasks: boolean;
    };
  };
  probes: {
    roots: CapabilityProbe;
    samplingBasic: CapabilityProbe;
    samplingTools: CapabilityProbe;
    elicitationForm: CapabilityProbe;
    elicitationUrl: CapabilityProbe;
    appInitialize: CapabilityProbe;
    appTheme: CapabilityProbe;
    appResize: CapabilityProbe;
    tasksCreate: CapabilityProbe;
    tasksPoll: CapabilityProbe;
    tasksInput: CapabilityProbe;
    tasksResult: CapabilityProbe;
    tasksCancel: CapabilityProbe;
  };
  overallStatus: "pending" | "complete" | "issues_detected";
};

export type ProbeKey = keyof CapabilityReport["probes"];

export type CapabilityReportContext = Pick<CapabilityReport, "runId" | "createdAt" | "expiresAt">;

type ProbeGroup = {
  title: string;
  keys: readonly ProbeKey[];
};

const PROBE_GROUPS = [
  {
    title: "Roots",
    keys: ["roots"] as const,
  },
  {
    title: "Sampling",
    keys: ["samplingBasic", "samplingTools"] as const,
  },
  {
    title: "Elicitation",
    keys: ["elicitationForm", "elicitationUrl"] as const,
  },
  {
    title: "MCP Apps",
    keys: ["appInitialize", "appTheme", "appResize"] as const,
  },
  {
    title: "Tasks",
    keys: ["tasksCreate", "tasksPoll", "tasksInput", "tasksResult", "tasksCancel"] as const,
  },
] as const satisfies readonly ProbeGroup[];

type ProbeGroupKey = (typeof PROBE_GROUPS)[number]["keys"][number];

({} satisfies Record<Exclude<ProbeKey, ProbeGroupKey>, never>);

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
      return isCapabilityEvidenceCategory(candidate.value)
        ? { kind: "category", value: candidate.value }
        : undefined;
    default:
      return undefined;
  }
}

function formatEvidence(evidence: CapabilityEvidence | undefined): string {
  if (evidence === undefined) return "";
  switch (evidence.kind) {
    case "count":
      return ` (count: ${evidence.value})`;
    case "durationMs":
      return ` (durationMs: ${evidence.value})`;
    case "flag":
      return ` (flag: ${evidence.value ? "yes" : "no"})`;
    case "category":
      return ` (category: ${evidence.value})`;
  }
}

export function normalizeCapabilityProbe(probe: CapabilityProbe): CapabilityProbe {
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

export function normalizeCapabilityReport(report: CapabilityReport, context?: CapabilityReportContext): CapabilityReport {
  const probes: CapabilityReport["probes"] = {
    roots: normalizeCapabilityProbe(report.probes.roots),
    samplingBasic: normalizeCapabilityProbe(report.probes.samplingBasic),
    samplingTools: normalizeCapabilityProbe(report.probes.samplingTools),
    elicitationForm: normalizeCapabilityProbe(report.probes.elicitationForm),
    elicitationUrl: normalizeCapabilityProbe(report.probes.elicitationUrl),
    appInitialize: normalizeCapabilityProbe(report.probes.appInitialize),
    appTheme: normalizeCapabilityProbe(report.probes.appTheme),
    appResize: normalizeCapabilityProbe(report.probes.appResize),
    tasksCreate: normalizeCapabilityProbe(report.probes.tasksCreate),
    tasksPoll: normalizeCapabilityProbe(report.probes.tasksPoll),
    tasksInput: normalizeCapabilityProbe(report.probes.tasksInput),
    tasksResult: normalizeCapabilityProbe(report.probes.tasksResult),
    tasksCancel: normalizeCapabilityProbe(report.probes.tasksCancel),
  };

  return {
    schemaVersion: report.schemaVersion,
    runId: context?.runId ?? report.runId,
    createdAt: context?.createdAt ?? report.createdAt,
    expiresAt: context?.expiresAt ?? report.expiresAt,
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

function formatProbeLine(name: ProbeKey, probe: CapabilityProbe): string {
  return `- ${name}: ${probe.status} [${probe.code}] ${probe.message}${formatEvidence(probe.evidence)}`;
}

function formatDeclared(value: boolean): string {
  return value ? "yes" : "no";
}

export function deriveOverallStatus(probes: readonly { status: ProbeStatus }[]): CapabilityReport["overallStatus"] {
  if (probes.some((probe) => probe.status === "pending")) return "pending";
  if (probes.some((probe) => probe.status === "failed")) return "issues_detected";
  return "complete";
}

function formatCapabilityReportNormalized(report: CapabilityReport): string {
  const lines = [
    "MCP client capabilities diagnostic",
    `Schema version: ${report.schemaVersion}`,
    `Run ID: ${report.runId}`,
    `Created at: ${report.createdAt}`,
    `Expires at: ${report.expiresAt}`,
    `Protocol generation: ${report.testedProtocolGeneration}`,
    `Overall status: ${report.overallStatus}`,
    "",
    "Client declarations:",
    `- Roots: ${formatDeclared(report.client.declared.roots)}`,
    `- Roots list changed: ${formatDeclared(report.client.declared.rootsListChanged)}`,
    `- Sampling: ${formatDeclared(report.client.declared.sampling)}`,
    `- Sampling tools: ${formatDeclared(report.client.declared.samplingTools)}`,
    `- Elicitation form: ${formatDeclared(report.client.declared.elicitationForm)}`,
    `- Elicitation URL: ${formatDeclared(report.client.declared.elicitationUrl)}`,
    `- Tasks: ${formatDeclared(report.client.declared.tasks)}`,
  ];

  for (const group of PROBE_GROUPS) {
    lines.push("", group.title);
    for (const key of group.keys) {
      lines.push(formatProbeLine(key, report.probes[key]));
    }
  }

  return lines.join("\n");
}

export function formatCapabilityReport(report: CapabilityReport): string {
  return formatCapabilityReportNormalized(normalizeCapabilityReport(report));
}

export function toCapabilityToolResult(report: CapabilityReport): CallToolResult {
  const normalized = normalizeCapabilityReport(report);
  return {
    content: [{ type: "text", text: formatCapabilityReportNormalized(normalized) }],
    structuredContent: normalized,
  };
}
