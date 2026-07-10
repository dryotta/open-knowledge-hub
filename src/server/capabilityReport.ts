import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ProbeStatus =
  | "passed"
  | "supported_not_completed"
  | "advertised_only"
  | "unsupported"
  | "failed"
  | "pending"
  | "not_exercised";

export type CapabilityEvidence =
  | { kind: "count"; value: number }
  | { kind: "number"; value: number }
  | { kind: "enum"; value: string };

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
] as const;

type ProbeKey = keyof CapabilityReport["probes"];

function formatEvidence(evidence: CapabilityEvidence | undefined): string {
  if (evidence === undefined) return "";
  if (evidence.kind === "enum") return ` (${evidence.kind}: ${evidence.value})`;
  return ` (${evidence.kind}: ${evidence.value})`;
}

function formatProbeLine(name: ProbeKey, probe: CapabilityProbe): string {
  return `- ${name}: ${probe.status} [${probe.code}] ${probe.message}${formatEvidence(probe.evidence)}`;
}

function formatDeclared(value: boolean): string {
  return value ? "yes" : "no";
}

export function deriveOverallStatus(probes: readonly Pick<CapabilityProbe, "status">[]): CapabilityReport["overallStatus"] {
  if (probes.some((probe) => probe.status === "pending")) return "pending";
  if (probes.some((probe) => probe.status === "failed")) return "issues_detected";
  return "complete";
}

export function formatCapabilityReport(report: CapabilityReport): string {
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

export function toCapabilityToolResult(report: CapabilityReport): CallToolResult {
  return {
    content: [{ type: "text", text: formatCapabilityReport(report) }],
    structuredContent: report,
  };
}
