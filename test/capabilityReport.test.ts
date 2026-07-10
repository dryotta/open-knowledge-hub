import { describe, expect, it } from "vitest";
import {
  deriveOverallStatus,
  formatCapabilityReport,
  toCapabilityToolResult,
  type CapabilityProbe,
  type CapabilityReport,
} from "../src/server/capabilityReport.js";

function makeReport(): CapabilityReport {
  return {
    schemaVersion: "1",
    runId: "run-123",
    createdAt: "2026-07-10T23:41:07.998Z",
    expiresAt: "2026-07-10T23:46:07.998Z",
    testedProtocolGeneration: "2025-11-25",
    client: {
      declared: {
        roots: true,
        rootsListChanged: false,
        sampling: true,
        samplingTools: true,
        elicitationForm: true,
        elicitationUrl: false,
        tasks: true,
      },
    },
    probes: {
      roots: { status: "passed", code: "roots.list", message: "Roots list is available.", evidence: { kind: "count", value: 2 } },
      samplingBasic: { status: "passed", code: "sampling.basic", message: "Sampling completed." },
      samplingTools: {
        status: "supported_not_completed",
        code: "sampling.tools",
        message: "Sampling tools advertised but not exercised.",
        evidence: { kind: "category", value: "advertised" },
      },
      elicitationForm: { status: "advertised_only", code: "elicitation.form", message: "Form elicitation advertised." },
      elicitationUrl: { status: "unsupported", code: "elicitation.url", message: "URL elicitation unsupported." },
      appInitialize: {
        status: "failed",
        code: "apps.initialize",
        message: "App initialize returned an error.",
        evidence: { kind: "durationMs", value: 640 },
      },
      appTheme: {
        status: "not_exercised",
        code: "apps.theme",
        message: "Theme callback not exercised.",
        evidence: { kind: "flag", value: false },
      },
      appResize: {
        status: "passed",
        code: "apps.resize",
        message: "Resize callback handled.",
        evidence: { kind: "category", value: "observed" },
      },
      tasksCreate: {
        status: "passed",
        code: "tasks.create",
        message: "Task creation works.",
        evidence: { kind: "count", value: 1 },
      },
      tasksPoll: {
        status: "pending",
        code: "tasks.poll",
        message: "Polling still in progress.",
        evidence: { kind: "durationMs", value: 15 },
      },
      tasksInput: { status: "passed", code: "tasks.input", message: "Task input handled." },
      tasksResult: { status: "passed", code: "tasks.result", message: "Task result handled." },
      tasksCancel: {
        status: "passed",
        code: "tasks.cancel",
        message: "Task cancellation handled.",
        evidence: { kind: "category", value: "exercised" },
      },
    },
    overallStatus: "pending",
  };
}

function makeHostileReport(): CapabilityReport {
  const report = makeReport();
  return {
    ...report,
    probes: {
      ...report.probes,
      roots: {
        ...report.probes.roots,
        evidence: { kind: "category", value: "file:///etc/passwd" } as unknown as CapabilityProbe["evidence"],
      },
      samplingBasic: {
        ...report.probes.samplingBasic,
        evidence: { kind: "count", value: Number.POSITIVE_INFINITY } as unknown as CapabilityProbe["evidence"],
      },
      appInitialize: {
        ...report.probes.appInitialize,
        evidence: { kind: "durationMs", value: 120_000 } as unknown as CapabilityProbe["evidence"],
      },
      tasksCreate: {
        ...report.probes.tasksCreate,
        evidence: { kind: "count", value: -7.8 } as unknown as CapabilityProbe["evidence"],
      },
    },
  };
}

describe("capability report", () => {
  it("derives overall status from pending, failed, and unsupported probes", () => {
    expect(deriveOverallStatus([{ status: "pending" }])).toBe("pending");
    expect(deriveOverallStatus([{ status: "failed" }])).toBe("issues_detected");
    expect(deriveOverallStatus([{ status: "failed" }, { status: "pending" }])).toBe("pending");
    expect(deriveOverallStatus([{ status: "unsupported" }])).toBe("complete");
  });

  it("formats a deterministic terminal report", () => {
    const report = makeReport();
    const text = formatCapabilityReport(report);
    expect(text).toBe(formatCapabilityReport(report));
    expect(text).toBe([
      "MCP client capabilities diagnostic",
      "Schema version: 1",
      "Run ID: run-123",
      "Created at: 2026-07-10T23:41:07.998Z",
      "Expires at: 2026-07-10T23:46:07.998Z",
      "Protocol generation: 2025-11-25",
      "Overall status: pending",
      "",
      "Client declarations:",
      "- Roots: yes",
      "- Roots list changed: no",
      "- Sampling: yes",
      "- Sampling tools: yes",
      "- Elicitation form: yes",
      "- Elicitation URL: no",
      "- Tasks: yes",
      "",
      "Roots",
      "- roots: passed [roots.list] Roots list is available. (count: 2)",
      "",
      "Sampling",
      "- samplingBasic: passed [sampling.basic] Sampling completed.",
      "- samplingTools: supported_not_completed [sampling.tools] Sampling tools advertised but not exercised. (category: advertised)",
      "",
      "Elicitation",
      "- elicitationForm: advertised_only [elicitation.form] Form elicitation advertised.",
      "- elicitationUrl: unsupported [elicitation.url] URL elicitation unsupported.",
      "",
      "MCP Apps",
      "- appInitialize: failed [apps.initialize] App initialize returned an error. (durationMs: 640)",
      "- appTheme: not_exercised [apps.theme] Theme callback not exercised. (flag: no)",
      "- appResize: passed [apps.resize] Resize callback handled. (category: observed)",
      "",
      "Tasks",
      "- tasksCreate: passed [tasks.create] Task creation works. (count: 1)",
      "- tasksPoll: pending [tasks.poll] Polling still in progress. (durationMs: 15)",
      "- tasksInput: passed [tasks.input] Task input handled.",
      "- tasksResult: passed [tasks.result] Task result handled.",
      "- tasksCancel: passed [tasks.cancel] Task cancellation handled. (category: exercised)",
    ].join("\n"));
  });

  it("redacts hostile evidence and clamps unsafe numeric input", () => {
    const report = makeHostileReport();
    const first = formatCapabilityReport(report);
    const second = formatCapabilityReport(report);
    const result = toCapabilityToolResult(report);

    expect(first).toBe(second);
    expect(first).not.toContain("file:///etc/passwd");
    expect(first).not.toContain("Infinity");
    expect(first).not.toContain("120000");
    expect(first).toContain("- samplingBasic: passed [sampling.basic] Sampling completed.");
    expect(first).toContain("- appInitialize: failed [apps.initialize] App initialize returned an error. (durationMs: 60000)");
    expect(first).toContain("- tasksCreate: passed [tasks.create] Task creation works. (count: 0)");
    expect(JSON.stringify(result.structuredContent)).not.toContain("file:///etc/passwd");
    expect(JSON.stringify(result.structuredContent)).not.toContain("Infinity");
    expect(JSON.stringify(result.structuredContent)).toContain("\"kind\":\"durationMs\",\"value\":60000");
    expect(JSON.stringify(result.structuredContent)).toContain("\"kind\":\"count\",\"value\":0");
    expect(result.content).toEqual([{ type: "text", text: first }]);
  });

  it("returns equivalent structuredContent and text content", () => {
    const report = makeReport();
    const result = toCapabilityToolResult(report);
    expect(result.structuredContent).toEqual(report);
    expect(result.content).toEqual([{ type: "text", text: formatCapabilityReport(report) }]);
  });
});
