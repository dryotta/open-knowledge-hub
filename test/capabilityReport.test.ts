import { describe, expect, it } from "vitest";
import {
  deriveOverallStatus,
  formatCapabilityReport,
  toCapabilityToolResult,
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
      samplingTools: { status: "supported_not_completed", code: "sampling.tools", message: "Sampling tools advertised but not exercised." },
      elicitationForm: { status: "advertised_only", code: "elicitation.form", message: "Form elicitation advertised." },
      elicitationUrl: { status: "unsupported", code: "elicitation.url", message: "URL elicitation unsupported." },
      appInitialize: { status: "failed", code: "apps.initialize", message: "App initialize returned an error." },
      appTheme: { status: "not_exercised", code: "apps.theme", message: "Theme callback not exercised." },
      appResize: { status: "passed", code: "apps.resize", message: "Resize callback handled.", evidence: { kind: "number", value: 640 } },
      tasksCreate: { status: "passed", code: "tasks.create", message: "Task creation works." },
      tasksPoll: { status: "pending", code: "tasks.poll", message: "Polling still in progress." },
      tasksInput: { status: "passed", code: "tasks.input", message: "Task input handled." },
      tasksResult: { status: "passed", code: "tasks.result", message: "Task result handled." },
      tasksCancel: { status: "passed", code: "tasks.cancel", message: "Task cancellation handled." },
    },
    overallStatus: "pending",
  };
}

describe("capability report", () => {
  it("derives overall status from pending, failed, and unsupported probes", () => {
    expect(deriveOverallStatus([{ status: "pending", code: "a", message: "x" }])).toBe("pending");
    expect(deriveOverallStatus([{ status: "failed", code: "a", message: "x" }])).toBe("issues_detected");
    expect(deriveOverallStatus([{ status: "unsupported", code: "a", message: "x" }])).toBe("complete");
  });

  it("formats a deterministic terminal report without sensitive payloads", () => {
    const report = makeReport();
    const text = formatCapabilityReport(report);
    expect(text).toContain("MCP client capabilities diagnostic");
    expect(text).toContain("Roots");
    expect(text).toContain("Sampling");
    expect(text).toContain("Elicitation");
    expect(text).toContain("MCP Apps");
    expect(text).toContain("Tasks");
    expect(text).not.toContain("file://");
    expect(text).not.toContain("secret");
  });

  it("returns equivalent structuredContent and text content", () => {
    const report = makeReport();
    const result = toCapabilityToolResult(report);
    expect(result.structuredContent).toEqual(report);
    expect(result.content).toEqual([{ type: "text", text: formatCapabilityReport(report) }]);
  });
});
