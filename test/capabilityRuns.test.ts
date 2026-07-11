import { describe, expect, it } from "vitest";
import type { CapabilityReport, CapabilityProbe } from "../src/server/capabilityReport.js";
import {
  CapabilityRunClientMismatchError,
  CapabilityRunExpiredError,
  CapabilityRunNotFoundError,
  CapabilityRunStore,
  type CapabilityRunContext,
} from "../src/server/capabilityRuns.js";

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

function probe(status: CapabilityProbe["status"], code = "probe.code", message = "Probe result."): CapabilityProbe {
  return { status, code, message };
}

function makeReport(
  context: CapabilityRunContext,
  probeOverrides: Partial<CapabilityReport["probes"]> = {},
): CapabilityReport {
  return {
    schemaVersion: "1",
    runId: context.id,
    createdAt: context.createdAt,
    expiresAt: context.expiresAt,
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
      roots: probe("passed", "roots.list", "Roots listed."),
      samplingBasic: probe("passed", "sampling.basic", "Sampling completed."),
      samplingTools: probe("supported_not_completed", "sampling.tools", "Sampling tools advertised."),
      elicitationForm: probe("advertised_only", "elicitation.form", "Form elicitation advertised."),
      elicitationUrl: probe("unsupported", "elicitation.url", "URL elicitation unsupported."),
      appInitialize: probe("passed", "apps.initialize", "App initialized."),
      appTheme: probe("passed", "apps.theme", "Theme callback completed."),
      appResize: probe("passed", "apps.resize", "Resize callback completed."),
      tasksCreate: probe("passed", "tasks.create", "Task created."),
      tasksPoll: probe("passed", "tasks.poll", "Task polled."),
      tasksInput: probe("passed", "tasks.input", "Task input handled."),
      tasksResult: probe("passed", "tasks.result", "Task result returned."),
      tasksCancel: probe("passed", "tasks.cancel", "Task cancelled."),
      ...probeOverrides,
    },
    overallStatus: "complete",
  };
}

describe("CapabilityRunStore", () => {
  it("generates unique opaque run IDs", () => {
    const clientKey = {};
    const store = new CapabilityRunStore();

    const first = store.createRun(clientKey, makeReport);
    const second = store.createRun(clientKey, makeReport);

    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("expires runs after 30 minutes and aborts in-flight work", () => {
    let nowMs = Date.parse("2026-07-10T23:59:00.000Z");
    const clientKey = {};
    const store = new CapabilityRunStore({ now: () => new Date(nowMs) });
    const run = store.createRun(clientKey, (context) =>
      makeReport(context, {
        appInitialize: probe("pending", "apps.initialize", "App initialize pending."),
        appTheme: probe("pending", "apps.theme", "Theme callback pending."),
        appResize: probe("passed", "apps.resize", "Resize callback completed."),
      }),
    );

    expect(run.expiresAt).toBe("2026-07-11T00:29:00.000Z");
    expect(run.abortController.signal.aborted).toBe(false);

    nowMs += THIRTY_MINUTES_MS;

    try {
      store.getRunForClient(clientKey, run.id);
      throw new Error("expected expired run access to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityRunExpiredError);
      const expiredError = error as CapabilityRunExpiredError;
      expect(expiredError.code).toBe("expired");
      expect(expiredError.report.probes.appInitialize.status).toBe("failed");
      expect(expiredError.report.probes.appInitialize.message).toBe("Probe expired before completion.");
      expect(expiredError.report.probes.appTheme.status).toBe("failed");
      expect(expiredError.report.probes.appResize.status).toBe("passed");
      expect(expiredError.report.overallStatus).toBe("issues_detected");
    }

    expect(run.abortController.signal.aborted).toBe(true);
    expect(() => store.getRunForClient(clientKey, run.id)).toThrow(CapabilityRunNotFoundError);
  });

  it("evicts the oldest run after 32 retained runs", () => {
    const clientKey = {};
    const store = new CapabilityRunStore();
    const runs = Array.from({ length: 33 }, () => store.createRun(clientKey, makeReport));

    expect(runs[0].abortController.signal.aborted).toBe(true);
    expect(() => store.getRunForClient(clientKey, runs[0].id)).toThrow(CapabilityRunNotFoundError);
    expect(store.listSnapshots(clientKey).map((snapshot) => snapshot.id)).toEqual(runs.slice(1).map((run) => run.id));
  });

  it("rejects a run requested by a different client", () => {
    const originalClient = { name: "same" };
    const differentClient = { name: "same" };
    const store = new CapabilityRunStore();
    const run = store.createRun(originalClient, makeReport);

    expect(store.getRunForClient(originalClient, run.id).id).toBe(run.id);
    expect(() => store.getRunForClient(differentClient, run.id)).toThrow(CapabilityRunClientMismatchError);
  });

  it("rejects expired run access by a different client without exposing the expired report", () => {
    let nowMs = Date.parse("2026-07-10T23:59:00.000Z");
    const originalClient = {};
    const differentClient = {};
    const store = new CapabilityRunStore({ now: () => new Date(nowMs) });
    const run = store.createRun(originalClient, (context) =>
      makeReport(context, {
        appInitialize: probe("pending", "apps.initialize", "App initialize pending."),
      }),
    );

    nowMs += THIRTY_MINUTES_MS;

    try {
      store.getRunForClient(differentClient, run.id);
      throw new Error("expected cross-client run access to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityRunClientMismatchError);
      expect("report" in (error as object)).toBe(false);
    }

    expect(run.abortController.signal.aborted).toBe(false);

    try {
      store.getRunForClient(originalClient, run.id);
      throw new Error("expected owner expired run access to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityRunExpiredError);
      expect((error as CapabilityRunExpiredError).report.probes.appInitialize.status).toBe("failed");
    }

    expect(run.abortController.signal.aborted).toBe(true);
  });

  it("distinguishes missing IDs from expired and cross-client access", () => {
    const store = new CapabilityRunStore();

    try {
      store.getRunForClient({}, "missing-run");
      throw new Error("expected missing run access to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityRunNotFoundError);
      expect((error as CapabilityRunNotFoundError).code).toBe("missing");
    }
  });

  it("stores only normalized report updates and task association", () => {
    const clientKey = {};
    const store = new CapabilityRunStore();
    const run = store.createRun(clientKey, makeReport);
    const rawReport = {
      ...makeReport({
        id: "spoofed-run-id",
        createdAt: "1999-01-01T00:00:00.000Z",
        expiresAt: "1999-01-01T00:30:00.000Z",
      }),
      rootUri: "file:///secret/root",
      generatedText: "generated secret",
      model: "gpt-secret",
      elicitedValue: "elicited secret",
      probes: {
        ...makeReport({
          id: "spoofed-run-id",
          createdAt: "1999-01-01T00:00:00.000Z",
          expiresAt: "1999-01-01T00:30:00.000Z",
        }).probes,
        roots: {
          ...probe("passed", "roots.list", "Roots listed."),
          evidence: { kind: "category", value: "file:///secret/root" },
          rawPayload: { uri: "file:///secret/root" },
        },
        samplingBasic: {
          ...probe("passed", "sampling.basic", "Sampling completed."),
          samplingInput: "raw prompt",
          model: "gpt-secret",
        },
      },
    } as unknown as CapabilityReport;

    store.updateReport(clientKey, run.id, rawReport);
    store.associateTaskId(clientKey, run.id, "task-123");

    const snapshot = store.getSnapshotForClient(clientKey, run.id);
    expect(snapshot.taskId).toBe("task-123");
    expect(snapshot.report.runId).toBe(run.id);
    expect(snapshot.report.createdAt).toBe(run.createdAt);
    expect(snapshot.report.expiresAt).toBe(run.expiresAt);
    expect(snapshot.report.probes.roots).toEqual({
      status: "passed",
      code: "roots.list",
      message: "Roots listed.",
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("file:///secret/root");
    expect(serialized).not.toContain("generated secret");
    expect(serialized).not.toContain("gpt-secret");
    expect(serialized).not.toContain("elicited secret");
    expect(serialized).not.toContain("raw prompt");
  });

  it("aborts runs idempotently", () => {
    const clientKey = {};
    const store = new CapabilityRunStore();
    const run = store.createRun(clientKey, makeReport);

    const first = store.abortRun(clientKey, run.id);
    const second = store.abortRun(clientKey, run.id);

    expect(run.abortController.signal.aborted).toBe(true);
    expect(first.id).toBe(run.id);
    expect(second.id).toBe(run.id);
    expect(store.getRunForClient(clientKey, run.id).abortController.signal.aborted).toBe(true);
  });
});
