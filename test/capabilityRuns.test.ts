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

  it("uses injected createId values and retries until it finds an unused run ID", () => {
    const clientKey = {};
    const ids = ["run-alpha", "run-alpha", "run-beta", "run-gamma"];
    const createId = () => {
      const next = ids.shift();
      if (next === undefined) {
        throw new Error("unexpected createId call");
      }
      return next;
    };
    const store = new CapabilityRunStore({ createId });

    const first = store.createRun(clientKey, makeReport);
    const second = store.createRun(clientKey, makeReport);
    const third = store.createRun(clientKey, makeReport);

    expect(first.id).toBe("run-alpha");
    expect(second.id).toBe("run-beta");
    expect(third.id).toBe("run-gamma");
    expect(store.listSnapshots(clientKey).map((snapshot) => snapshot.id)).toEqual([
      "run-alpha",
      "run-beta",
      "run-gamma",
    ]);
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
    expect(run.signal.aborted).toBe(false);
    expect("abortController" in run).toBe(false);
    expect("abort" in run.signal).toBe(false);

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

    expect(run.signal.aborted).toBe(true);
    expect(() => store.getRunForClient(clientKey, run.id)).toThrow(CapabilityRunNotFoundError);
  });

  it("evicts the oldest run after 32 retained runs", () => {
    const clientKey = {};
    const store = new CapabilityRunStore();
    const runs = Array.from({ length: 33 }, () => store.createRun(clientKey, makeReport));

    expect(runs[0].signal.aborted).toBe(true);
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

    expect(run.signal.aborted).toBe(false);

    try {
      store.getRunForClient(originalClient, run.id);
      throw new Error("expected owner expired run access to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityRunExpiredError);
      expect((error as CapabilityRunExpiredError).report.probes.appInitialize.status).toBe("failed");
    }

    expect(run.signal.aborted).toBe(true);
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

  it("updates only pending probes and lets explicit replacements advance terminal lifecycle states", () => {
    const clientKey = {};
    const store = new CapabilityRunStore();
    const run = store.createRun(clientKey, (context) =>
      makeReport(context, {
        roots: probe("pending", "roots.pending", "Roots pending."),
      }),
    );

    const first = store.updateProbe(clientKey, run.id, "roots", {
      status: "failed",
      code: "roots.failed",
      message: "Roots failed.",
      evidence: { kind: "category", value: "file:///secret/root" } as unknown as CapabilityProbe["evidence"],
    });
    const late = store.updateProbe(clientKey, run.id, "roots", probe("passed", "roots.late", "Late roots result."));
    const replaced = store.replaceProbe(clientKey, run.id, "roots", probe("passed", "roots.followup", "Follow-up roots result."));

    expect(first.report.probes.roots).toEqual({
      status: "failed",
      code: "roots.failed",
      message: "Roots failed.",
    });
    expect(first.report.overallStatus).toBe("issues_detected");
    expect(late.report.probes.roots).toEqual(first.report.probes.roots);
    expect(late.report.overallStatus).toBe("issues_detected");
    expect(replaced.report.probes.roots).toEqual({
      status: "passed",
      code: "roots.followup",
      message: "Follow-up roots result.",
    });
    expect(replaced.report.overallStatus).toBe("complete");
  });

  it("merges report updates without regressing existing terminal probes", () => {
    const clientKey = {};
    const store = new CapabilityRunStore();
    const run = store.createRun(clientKey, (context) =>
      makeReport(context, {
        roots: probe("pending", "roots.pending", "Roots pending."),
        samplingBasic: probe("pending", "sampling.pending", "Sampling pending."),
      }),
    );

    store.updateProbe(clientKey, run.id, "roots", probe("failed", "roots.failed", "Roots failed."));
    const snapshot = store.updateReport(
      clientKey,
      run.id,
      makeReport(
        {
          id: "spoofed-run-id",
          createdAt: "1999-01-01T00:00:00.000Z",
          expiresAt: "1999-01-01T00:30:00.000Z",
        },
        {
          roots: probe("passed", "roots.late", "Late roots success."),
          samplingBasic: probe("passed", "sampling.done", "Sampling completed."),
        },
      ),
    );

    expect(snapshot.report.runId).toBe(run.id);
    expect(snapshot.report.createdAt).toBe(run.createdAt);
    expect(snapshot.report.expiresAt).toBe(run.expiresAt);
    expect(snapshot.report.probes.roots).toEqual(probe("failed", "roots.failed", "Roots failed."));
    expect(snapshot.report.probes.samplingBasic).toEqual(probe("passed", "sampling.done", "Sampling completed."));
    expect(snapshot.report.overallStatus).toBe("issues_detected");
  });

  it("disposes active runs idempotently", () => {
    const firstClient = {};
    const secondClient = {};
    const store = new CapabilityRunStore();
    const first = store.createRun(firstClient, makeReport);
    const second = store.createRun(secondClient, makeReport);

    store.dispose();
    store.dispose();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(store.listSnapshots(firstClient)).toEqual([]);
    expect(store.listSnapshots(secondClient)).toEqual([]);
    expect(() => store.getRunForClient(firstClient, first.id)).toThrow(CapabilityRunNotFoundError);
    expect(() => store.getRunForClient(secondClient, second.id)).toThrow(CapabilityRunNotFoundError);
  });

  it("aborts runs idempotently", () => {
    const clientKey = {};
    const store = new CapabilityRunStore();
    const run = store.createRun(clientKey, makeReport);

    const first = store.abortRun(clientKey, run.id);
    const second = store.abortRun(clientKey, run.id);

    expect(run.signal.aborted).toBe(true);
    expect(first.id).toBe(run.id);
    expect(second.id).toBe(run.id);
    expect(store.getRunForClient(clientKey, run.id).signal.aborted).toBe(true);
  });

  it("freezes pending probe-runner probes on abort so late results cannot overwrite them", () => {
    const clientKey = {};
    const store = new CapabilityRunStore();
    const run = store.createRun(clientKey, (context) =>
      makeReport(context, {
        roots: probe("pending", "roots.list", "Roots listing is pending."),
        samplingBasic: probe("pending", "sampling.basic", "Basic sampling is pending."),
        elicitationForm: probe("passed", "elicitation.form", "Form elicitation accepted."),
      }),
    );

    store.abortRun(clientKey, run.id);

    const afterAbort = store.getSnapshotForClient(clientKey, run.id).report.probes;
    expect(afterAbort.roots.status).toBe("not_exercised");
    expect(afterAbort.roots.message).toBe("Scan was cancelled before this probe completed.");
    expect(afterAbort.samplingBasic.status).toBe("not_exercised");
    expect(afterAbort.elicitationForm.status).toBe("passed");

    store.updateProbe(clientKey, run.id, "roots", probe("passed", "roots.list", "Roots listed."));

    expect(store.getSnapshotForClient(clientKey, run.id).report.probes.roots.status).toBe(
      "not_exercised",
    );
  });
});