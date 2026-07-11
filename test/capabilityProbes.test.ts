import { describe, it, expect, vi } from "vitest";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_APPS_EXTENSION,
  DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS,
  runCapabilityProbes,
  formatCapabilityReport,
  type CapabilityProbeOperations,
} from "../src/server/capabilityProbes.js";

function makeOps(
  caps: ClientCapabilities | undefined,
  overrides: Partial<Omit<CapabilityProbeOperations, "capabilities">> = {},
): CapabilityProbeOperations {
  return {
    capabilities: () => caps,
    roots: vi.fn().mockResolvedValue(undefined),
    sampling: vi.fn().mockResolvedValue(undefined),
    elicitation: vi.fn().mockResolvedValue("accept" as const),
    ...overrides,
  };
}

describe("constants", () => {
  it("MCP_APPS_EXTENSION has correct value", () => {
    expect(MCP_APPS_EXTENSION).toBe("io.modelcontextprotocol/ui");
  });

  it("DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS is 60 000", () => {
    expect(DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS).toBe(60_000);
  });
});

describe("runCapabilityProbes — unsupported features are not called", () => {
  it("does not call roots/sampling/elicitation when capabilities() returns undefined", async () => {
    const ops = makeOps(undefined);
    const report = await runCapabilityProbes(ops);

    expect(ops.roots).not.toHaveBeenCalled();
    expect(ops.sampling).not.toHaveBeenCalled();
    expect(ops.elicitation).not.toHaveBeenCalled();

    expect(report.features.roots.status).toBe("unsupported");
    expect(report.features.roots.available).toBe(false);
    expect(report.features.sampling.status).toBe("unsupported");
    expect(report.features.sampling.available).toBe(false);
    expect(report.features.elicitation.status).toBe("unsupported");
    expect(report.features.elicitation.available).toBe(false);
    expect(report.features.apps.status).toBe("unsupported");
    expect(report.features.apps.available).toBe(false);
    expect(report.features.serverTools.status).toBe("unsupported");
    expect(report.features.serverTools.available).toBe(false);
  });

  it("does not call roots when roots capability is absent", async () => {
    const ops = makeOps({ sampling: {} });
    await runCapabilityProbes(ops);
    expect(ops.roots).not.toHaveBeenCalled();
  });

  it("does not call sampling when sampling capability is absent", async () => {
    const ops = makeOps({ roots: {} });
    await runCapabilityProbes(ops);
    expect(ops.sampling).not.toHaveBeenCalled();
  });

  it("does not call elicitation when elicitation capability is absent", async () => {
    const ops = makeOps({ roots: {} });
    await runCapabilityProbes(ops);
    expect(ops.elicitation).not.toHaveBeenCalled();
  });
});

describe("runCapabilityProbes — all advertised and passing", () => {
  it("executes probes in roots/sampling/elicitation order", async () => {
    const callOrder: string[] = [];
    const ops = makeOps(
      { roots: {}, sampling: {}, elicitation: {} },
      {
        roots: vi.fn().mockImplementation(async () => { callOrder.push("roots"); }),
        sampling: vi.fn().mockImplementation(async () => { callOrder.push("sampling"); }),
        elicitation: vi.fn().mockImplementation(async () => { callOrder.push("elicitation"); return "accept" as const; }),
      },
    );

    await runCapabilityProbes(ops);

    expect(callOrder).toEqual(["roots", "sampling", "elicitation"]);
  });

  it("all probes return passed when operations succeed", async () => {
    const ops = makeOps({ roots: {}, sampling: {}, elicitation: {} });
    const report = await runCapabilityProbes(ops);

    expect(report.features.roots.status).toBe("passed");
    expect(report.features.roots.message).toBe("Roots request succeeded.");
    expect(report.features.roots.available).toBe(true);
    expect(report.features.sampling.status).toBe("passed");
    expect(report.features.sampling.message).toBe("Sampling request succeeded.");
    expect(report.features.sampling.available).toBe(true);
    expect(report.features.elicitation.status).toBe("passed");
    expect(report.features.elicitation.message).toBe("Elicitation request succeeded.");
    expect(report.features.elicitation.available).toBe(true);
  });
});

describe("runCapabilityProbes — MCP Apps", () => {
  it("reports advertised when extensions contains the UI key", async () => {
    const ops = makeOps({ extensions: { [MCP_APPS_EXTENSION]: {} } });
    const report = await runCapabilityProbes(ops);

    expect(report.features.apps.status).toBe("advertised");
    expect(report.features.apps.message).toBe("MCP Apps extension is advertised.");
    expect(report.features.apps.available).toBe(true);

    // Host serverTools proxying can't be observed server-side; report as unknown.
    expect(report.features.serverTools.status).toBe("unknown");
    expect(report.features.serverTools.available).toBe(false);
  });

  it("reports unsupported when extensions are absent", async () => {
    const ops = makeOps({});
    const report = await runCapabilityProbes(ops);
    expect(report.features.apps.status).toBe("unsupported");
    expect(report.features.apps.available).toBe(false);
  });

  it("reports unsupported when UI extension is not present in extensions", async () => {
    const ops = makeOps({ extensions: { "other/extension": {} } });
    const report = await runCapabilityProbes(ops);
    expect(report.features.apps.status).toBe("unsupported");
  });
});

describe("runCapabilityProbes — elicitation decline and cancel", () => {
  it("reports declined when elicitation action is decline", async () => {
    const ops = makeOps(
      { elicitation: {} },
      { elicitation: vi.fn().mockResolvedValue("decline" as const) },
    );
    const report = await runCapabilityProbes(ops);

    expect(report.features.elicitation.status).toBe("declined");
    expect(report.features.elicitation.message).toBe("Elicitation was declined or cancelled.");
    expect(report.features.elicitation.available).toBe(true);
  });

  it("reports declined when elicitation action is cancel", async () => {
    const ops = makeOps(
      { elicitation: {} },
      { elicitation: vi.fn().mockResolvedValue("cancel" as const) },
    );
    const report = await runCapabilityProbes(ops);

    expect(report.features.elicitation.status).toBe("declined");
    expect(report.features.elicitation.message).toBe("Elicitation was declined or cancelled.");
    expect(report.features.elicitation.available).toBe(true);
  });
});

describe("runCapabilityProbes — failure isolation", () => {
  it("continues to later probes when roots fails", async () => {
    const secretError = "secret internal error detail";
    const ops = makeOps(
      { roots: {}, sampling: {}, elicitation: {} },
      { roots: vi.fn().mockRejectedValue(new Error(secretError)) },
    );
    const report = await runCapabilityProbes(ops);

    expect(report.features.roots.status).toBe("failed");
    expect(report.features.roots.message).toBe("Roots request failed.");
    expect(report.features.roots.message).not.toContain(secretError);
    expect(report.features.roots.available).toBe(true);

    expect(ops.sampling).toHaveBeenCalled();
    expect(report.features.sampling.status).toBe("passed");
    expect(report.features.sampling.available).toBe(true);

    expect(ops.elicitation).toHaveBeenCalled();
    expect(report.features.elicitation.status).toBe("passed");
    expect(report.features.elicitation.available).toBe(true);
  });

  it("continues to elicitation when sampling fails", async () => {
    const ops = makeOps(
      { sampling: {}, elicitation: {} },
      { sampling: vi.fn().mockRejectedValue(new Error("sampling error")) },
    );
    const report = await runCapabilityProbes(ops);

    expect(report.features.sampling.status).toBe("failed");
    expect(report.features.sampling.message).toBe("Sampling request failed.");
    expect(report.features.sampling.message).not.toContain("sampling error");
    expect(report.features.sampling.available).toBe(true);

    expect(ops.elicitation).toHaveBeenCalled();
    expect(report.features.elicitation.status).toBe("passed");
    expect(report.features.elicitation.available).toBe(true);
  });

  it("does not echo raw error text from elicitation failure", async () => {
    const secretError = "internal elicitation secret";
    const ops = makeOps(
      { elicitation: {} },
      { elicitation: vi.fn().mockRejectedValue(new Error(secretError)) },
    );
    const report = await runCapabilityProbes(ops);

    expect(report.features.elicitation.status).toBe("failed");
    expect(report.features.elicitation.message).toBe("Elicitation request failed.");
    expect(report.features.elicitation.message).not.toContain(secretError);
    expect(report.features.elicitation.available).toBe(true);
  });
});

describe("runCapabilityProbes — URL-only elicitation is not called", () => {
  it("does not call elicitation when only url mode is advertised", async () => {
    const ops = makeOps({ elicitation: { url: {} } });
    const report = await runCapabilityProbes(ops);

    expect(ops.elicitation).not.toHaveBeenCalled();
    expect(report.features.elicitation.status).toBe("unsupported");
    expect(report.features.elicitation.message).toBe("Form elicitation is not advertised.");
  });

  it("calls elicitation when both form and url are advertised", async () => {
    const ops = makeOps({ elicitation: { form: {}, url: {} } });
    const report = await runCapabilityProbes(ops);

    expect(ops.elicitation).toHaveBeenCalled();
    expect(report.features.elicitation.status).toBe("passed");
  });

  it("calls elicitation when empty elicitation capability is advertised (backward compat)", async () => {
    const ops = makeOps({ elicitation: {} });
    const report = await runCapabilityProbes(ops);

    expect(ops.elicitation).toHaveBeenCalled();
    expect(report.features.elicitation.status).toBe("passed");
  });
});

describe("CapabilityReport shape — structured content compatibility", () => {
  it("report has a features property, not top-level feature keys", async () => {
    const ops = makeOps(undefined);
    const report = await runCapabilityProbes(ops);

    // { features: report.features } is the approved structured-content shape;
    // { features: report } (the old nesting) would fail this assertion.
    expect(report).toHaveProperty("features");
    expect(report).not.toHaveProperty("roots");
    expect(report).not.toHaveProperty("sampling");
    expect(report).not.toHaveProperty("elicitation");
    expect(report).not.toHaveProperty("apps");
  });
});

describe("formatCapabilityReport", () => {
  it("returns one fixed line per feature", () => {
    const report = {
      features: {
        roots: { status: "passed" as const, available: true, message: "Roots request succeeded." },
        sampling: { status: "unsupported" as const, available: false, message: "Sampling is not advertised." },
        elicitation: { status: "failed" as const, available: true, message: "Elicitation request failed." },
        apps: { status: "advertised" as const, available: true, message: "MCP Apps extension is advertised." },
        serverTools: { status: "unknown" as const, available: false, message: "verify in-app." },
      },
    };

    const output = formatCapabilityReport(report);
    const lines = output.split("\n");

    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("Roots: Roots request succeeded.");
    expect(lines[1]).toBe("Sampling: Sampling is not advertised.");
    expect(lines[2]).toBe("Form Elicitation: Elicitation request failed.");
    expect(lines[3]).toBe("MCP Apps: MCP Apps extension is advertised.");
    expect(lines[4]).toBe("App Server Tools: verify in-app.");
  });

  it("does not include raw response values", () => {
    const report = {
      features: {
        roots: { status: "passed" as const, available: true, message: "Roots request succeeded." },
        sampling: { status: "passed" as const, available: true, message: "Sampling request succeeded." },
        elicitation: { status: "passed" as const, available: true, message: "Elicitation request succeeded." },
        apps: { status: "unsupported" as const, available: false, message: "MCP Apps is not advertised." },
        serverTools: { status: "unsupported" as const, available: false, message: "does not apply." },
      },
    };

    const output = formatCapabilityReport(report);
    // Output must be exactly the fixed summary lines — no observed LLM text or URIs injected
    expect(output).toBe(
      "Roots: Roots request succeeded.\n" +
        "Sampling: Sampling request succeeded.\n" +
        "Form Elicitation: Elicitation request succeeded.\n" +
        "MCP Apps: MCP Apps is not advertised.\n" +
        "App Server Tools: does not apply.",
    );
  });
});
