# MCP Client Capabilities Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one `capabilities` MCP tool that safely reports and actively probes roots, sampling, elicitation, MCP Apps, and legacy Tasks, with equivalent App and terminal output.

**Architecture:** Keep the existing SDK v1/Node 18 server and register `capabilities` as an optional task tool. A redacted in-memory run store owns normalized state; focused probe, report, and task-store modules update that state; one packaged HTML resource performs the MCP Apps callback.

**Tech Stack:** TypeScript, Node.js 18+, `@modelcontextprotocol/sdk` v1.29, Zod 4, Vitest 4, promptfoo/Copilot CLI eval harness.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/server/capabilityReport.ts` | Shared report types, status aggregation, fixed text formatting, and `CallToolResult` conversion. |
| `src/server/capabilityRuns.ts` | Bounded, client-bound, redacted run state with expiry and abort handling. |
| `src/server/capabilityProbes.ts` | Client-capability normalization plus roots, sampling, and elicitation probes. |
| `src/server/capabilityTaskStore.ts` | Observe task creation/poll/result/cancel while delegating storage to SDK v1's task store. |
| `src/server/capabilities.ts` | Validate actions, register the optional task tool and App resource, and orchestrate scan/follow-up actions. |
| `resources/apps/capabilities.html` | Self-contained MCP App that initializes, observes theme/resize, calls `capabilities app_report`, and renders the normalized report. |
| `resources/tool-meta/capabilities.md` | Model-facing title, argument descriptions, and terminal fallback instructions. |
| `src/server/toolSchemas.ts` | Add the raw Zod shape for `capabilities`. |
| `src/server/index.ts` | Construct task/run dependencies, advertise Apps/Tasks, and register the diagnostic. |
| `test/capabilityReport.test.ts` | Report status and text/structured-output unit tests. |
| `test/capabilityRuns.test.ts` | Expiry, capacity, client binding, late update, and redaction-state tests. |
| `test/capabilityProbes.test.ts` | Capability normalization and probe success/decline/error/privacy tests. |
| `test/capabilityTaskStore.test.ts` | Task observation and dynamic result-formatting tests. |
| `test/capabilities.test.ts` | In-memory MCP integration tests for the full diagnostic surface. |
| `test/server.test.ts` | Update the exact public tool/resource surface assertions. |
| `eval/scenarios/capabilities/terminal-fallback.yaml` | Copilot CLI fallback scenario. |
| `README.md` | Document the tenth tool, App resource, and terminal fallback. |
| `DEVELOPMENT.md` | Add Inspector, GUI-host, terminal, and full validation guidance. |
| `eval/README.md` | Document the capabilities scenario and remove the stale fixed scenario count. |

No dependency change is required. Do not add `@modelcontextprotocol/ext-apps`; the packaged HTML implements only the small postMessage protocol surface needed by this diagnostic.

### Task 1: Define the normalized report and formatter

**Files:**
- Create: `src/server/capabilityReport.ts`
- Create: `test/capabilityReport.test.ts`

- [ ] **Step 1: Write failing report tests**

Create `test/capabilityReport.test.ts` with a complete report fixture and assertions for overall status, fixed ordering, next actions, and structured/text equivalence:

```ts
import { describe, expect, it } from "vitest";
import {
  PROBE_KEYS,
  capabilityReportResult,
  calculateOverall,
  formatCapabilityReport,
  type CapabilityReport,
  type ProbeStatus,
} from "../src/server/capabilityReport.js";

function reportWith(statuses: Partial<Record<(typeof PROBE_KEYS)[number], ProbeStatus>> = {}): CapabilityReport {
  const probes = Object.fromEntries(
    PROBE_KEYS.map((key) => [
      key,
      { status: statuses[key] ?? "unsupported", advertised: false },
    ]),
  ) as CapabilityReport["probes"];
  return {
    runId: "run-123",
    overall: calculateOverall(probes),
    client: { name: "test-client", version: "1.0", protocolVersion: "2025-11-25" },
    advertised: {
      capabilityKeys: ["roots"],
      extensionIds: [],
      roots: { listChanged: false },
    },
    probes,
    nextActions: [],
  };
}

describe("capability report", () => {
  it("is pending when any probe is pending", () => {
    expect(reportWith({ mcpAppsRender: "pending" }).overall).toBe("pending");
  });

  it("is partial when a terminal probe failed", () => {
    expect(reportWith({ samplingBasic: "failed" }).overall).toBe("partial");
  });

  it("is complete for unsupported, advertised-only, declined, and unexercised results", () => {
    expect(
      reportWith({
        rootsListChanged: "advertised_only",
        elicitationForm: "supported_not_completed",
        modernProtocol: "not_exercised",
      }).overall,
    ).toBe("complete");
  });

  it("formats every probe in stable order without copying payload data", () => {
    const text = formatCapabilityReport(reportWith());
    expect(text).toContain("MCP client capabilities - complete");
    expect(text).toContain("Run: run-123");
    expect(text.indexOf("roots")).toBeLessThan(text.indexOf("samplingBasic"));
    expect(text).not.toContain("file:///secret");
  });

  it("returns the same normalized report as structured content", () => {
    const report = reportWith({ legacyTaskCancel: "not_exercised" });
    const result = capabilityReportResult(report);
    expect(result.structuredContent).toEqual(report);
    expect(result.content).toEqual([{ type: "text", text: formatCapabilityReport(report) }]);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run:

```powershell
npx vitest run test/capabilityReport.test.ts
```

Expected: FAIL because `src/server/capabilityReport.ts` does not exist.

- [ ] **Step 3: Implement report types and deterministic formatting**

Create `src/server/capabilityReport.ts` with these exported types and constants:

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const PROBE_KEYS = [
  "roots",
  "rootsListChanged",
  "samplingBasic",
  "samplingTools",
  "elicitationForm",
  "elicitationUrl",
  "mcpAppsRender",
  "mcpAppsTheme",
  "mcpAppsResize",
  "mcpAppsServerCall",
  "legacyTaskCreate",
  "legacyTaskPoll",
  "legacyTaskInputRequired",
  "legacyTaskResult",
  "legacyTaskCancel",
  "modernProtocol",
  "tasksExtension",
] as const;

export type ProbeKey = (typeof PROBE_KEYS)[number];
export type ProbeStatus =
  | "passed"
  | "supported_not_completed"
  | "advertised_only"
  | "unsupported"
  | "failed"
  | "pending"
  | "not_exercised";

export interface CapabilityProbeResult {
  status: ProbeStatus;
  advertised?: boolean;
  durationMs?: number;
  detail?: string;
  errorCode?: string;
}

export interface AdvertisedCapabilities {
  capabilityKeys: string[];
  extensionIds: string[];
  roots?: { listChanged?: boolean };
  sampling?: { context?: boolean; tools?: boolean };
  elicitation?: { form?: boolean; url?: boolean };
  tasks?: {
    list: boolean;
    cancel: boolean;
    samplingCreateMessage: boolean;
    elicitationCreate: boolean;
  };
}

export interface CapabilityReport {
  runId: string;
  overall: "pending" | "complete" | "partial";
  client: {
    name?: string;
    version?: string;
    protocolVersion?: string;
  };
  advertised: AdvertisedCapabilities;
  probes: Record<ProbeKey, CapabilityProbeResult>;
  nextActions: string[];
}

export function calculateOverall(
  probes: CapabilityReport["probes"],
): CapabilityReport["overall"] {
  const statuses = PROBE_KEYS.map((key) => probes[key].status);
  if (statuses.includes("pending")) return "pending";
  if (statuses.includes("failed")) return "partial";
  return "complete";
}

export function normalizeReport(report: CapabilityReport): CapabilityReport {
  return {
    ...report,
    overall: calculateOverall(report.probes),
    advertised: {
      ...report.advertised,
      capabilityKeys: [...report.advertised.capabilityKeys].sort(),
      extensionIds: [...report.advertised.extensionIds].sort(),
    },
    nextActions: [...report.nextActions],
  };
}

export function formatCapabilityReport(input: CapabilityReport): string {
  const report = normalizeReport(input);
  const lines = [
    `MCP client capabilities - ${report.overall}`,
    `Run: ${report.runId}`,
    `Client: ${[report.client.name, report.client.version].filter(Boolean).join(" ") || "unknown"}`,
    `Protocol generation: ${report.client.protocolVersion ?? "unknown"}`,
    "",
    "| Probe | Status | Detail |",
    "| --- | --- | --- |",
  ];
  for (const key of PROBE_KEYS) {
    const probe = report.probes[key];
    lines.push(`| ${key} | ${probe.status} | ${probe.detail ?? ""} |`);
  }
  if (report.nextActions.length > 0) {
    lines.push("", "Next actions:", ...report.nextActions.map((action) => `- ${action}`));
  }
  return lines.join("\n");
}

export function capabilityReportResult(report: CapabilityReport): CallToolResult {
  const normalized = normalizeReport(report);
  return {
    content: [{ type: "text", text: formatCapabilityReport(normalized) }],
    structuredContent: normalized,
  };
}
```

- [ ] **Step 4: Run the focused test**

Run:

```powershell
npx vitest run test/capabilityReport.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Commit the report layer**

```powershell
git add src\server\capabilityReport.ts test\capabilityReport.test.ts
git commit -m "feat: define capability diagnostic report" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 7209fade-87bf-4294-81fb-0d4b01bd52f4"
```

### Task 2: Add bounded redacted run state

**Files:**
- Create: `src/server/capabilityRuns.ts`
- Create: `test/capabilityRuns.test.ts`

- [ ] **Step 1: Write failing run-store tests**

Create tests using injected time and IDs:

```ts
import { describe, expect, it } from "vitest";
import { CapabilityRunStore, CapabilityRunStoreError } from "../src/server/capabilityRuns.js";
import { PROBE_KEYS, type CapabilityReport } from "../src/server/capabilityReport.js";

function baseReport(runId: string): CapabilityReport {
  return {
    runId,
    overall: "pending",
    client: { name: "client", version: "1", protocolVersion: "2025-11-25" },
    advertised: { capabilityKeys: [], extensionIds: [] },
    probes: Object.fromEntries(
      PROBE_KEYS.map((key) => [key, { status: "pending" }]),
    ) as CapabilityReport["probes"],
    nextActions: [],
  };
}

describe("CapabilityRunStore", () => {
  it("binds follow-ups to the creating client", () => {
    const store = new CapabilityRunStore({ now: () => 0, ttlMs: 100, maxRuns: 2 });
    store.create(baseReport("a"), "client-a");
    expect(store.report("a", "client-a").runId).toBe("a");
    expect(() => store.report("a", "client-b")).toThrowError(
      new CapabilityRunStoreError("wrong_client", "Capability run belongs to another client."),
    );
  });

  it("rejects and removes expired runs", () => {
    let now = 0;
    const store = new CapabilityRunStore({ now: () => now, ttlMs: 100, maxRuns: 2 });
    store.create(baseReport("a"), undefined);
    now = 101;
    expect(() => store.report("a")).toThrowError(/expired/i);
    expect(() => store.report("a")).toThrowError(/unknown/i);
  });

  it("evicts expired entries before the oldest live entry", () => {
    let now = 0;
    const store = new CapabilityRunStore({ now: () => now, ttlMs: 10, maxRuns: 2 });
    store.create(baseReport("a"));
    now = 5;
    store.create(baseReport("b"));
    now = 11;
    store.create(baseReport("c"));
    expect(() => store.report("a")).toThrow();
    expect(store.report("b").runId).toBe("b");
    expect(store.report("c").runId).toBe("c");
  });

  it("does not let late updates overwrite terminal probe state", () => {
    const store = new CapabilityRunStore({ now: () => 0, ttlMs: 100, maxRuns: 2 });
    store.create(baseReport("a"));
    store.updateProbe("a", "roots", { status: "failed", errorCode: "timeout" });
    store.updateProbe("a", "roots", { status: "passed" });
    expect(store.report("a").probes.roots.status).toBe("failed");
  });

  it("aborts every active run during cleanup", () => {
    const store = new CapabilityRunStore({ now: () => 0, ttlMs: 100, maxRuns: 2 });
    const run = store.create(baseReport("a"));
    store.dispose();
    expect(run.signal.aborted).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```powershell
npx vitest run test/capabilityRuns.test.ts
```

Expected: FAIL because the run-store module does not exist.

- [ ] **Step 3: Implement the run store**

Create `src/server/capabilityRuns.ts`:

```ts
import {
  calculateOverall,
  type CapabilityProbeResult,
  type CapabilityReport,
  type ProbeKey,
} from "./capabilityReport.js";

export type CapabilityRunStoreErrorCode = "unknown_run" | "expired_run" | "wrong_client";

export class CapabilityRunStoreError extends Error {
  constructor(
    readonly code: CapabilityRunStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityRunStoreError";
  }
}

export interface CapabilityRun {
  report: CapabilityReport;
  clientKey?: string;
  createdAt: number;
  expiresAt: number;
  signal: AbortSignal;
}

interface StoredCapabilityRun extends CapabilityRun {
  controller: AbortController;
}

export interface CapabilityRunStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxRuns?: number;
}

export class CapabilityRunStore {
  private readonly runs = new Map<string, StoredCapabilityRun>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxRuns: number;

  constructor(options: CapabilityRunStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.maxRuns = options.maxRuns ?? 32;
  }

  create(report: CapabilityReport, clientKey?: string): CapabilityRun {
    const now = this.now();
    this.pruneExpired(now);
    while (this.runs.size >= this.maxRuns) {
      const oldest = this.runs.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    const controller = new AbortController();
    const run: StoredCapabilityRun = {
      report,
      ...(clientKey ? { clientKey } : {}),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      signal: controller.signal,
      controller,
    };
    this.runs.set(report.runId, run);
    return run;
  }

  report(runId: string, clientKey?: string): CapabilityReport {
    return structuredClone(this.requireRun(runId, clientKey).report);
  }

  signal(runId: string): AbortSignal {
    return this.requireRun(runId).signal;
  }

  updateProbe(runId: string, key: ProbeKey, next: CapabilityProbeResult): void {
    const run = this.requireRun(runId);
    const current = run.report.probes[key];
    if (current.status !== "pending") return;
    run.report.probes[key] = { ...next };
    run.report.overall = calculateOverall(run.report.probes);
  }

  replaceProbe(runId: string, key: ProbeKey, next: CapabilityProbeResult): void {
    const run = this.requireRun(runId);
    run.report.probes[key] = { ...next };
    run.report.overall = calculateOverall(run.report.probes);
  }

  setNextActions(runId: string, nextActions: string[]): void {
    this.requireRun(runId).report.nextActions = [...nextActions];
  }

  abort(runId: string): void {
    this.requireRun(runId).controller.abort();
  }

  dispose(): void {
    for (const runId of [...this.runs.keys()]) this.remove(runId);
  }

  private requireRun(runId: string, clientKey?: string): StoredCapabilityRun {
    const run = this.runs.get(runId);
    if (!run) throw new CapabilityRunStoreError("unknown_run", "Unknown capability run.");
    if (this.now() >= run.expiresAt) {
      this.remove(runId);
      throw new CapabilityRunStoreError("expired_run", "Capability run expired.");
    }
    if (run.clientKey && clientKey && run.clientKey !== clientKey) {
      throw new CapabilityRunStoreError("wrong_client", "Capability run belongs to another client.");
    }
    return run;
  }

  private pruneExpired(now: number): void {
    for (const [runId, run] of this.runs) {
      if (now >= run.expiresAt) this.remove(runId);
    }
  }

  private remove(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.controller.abort();
    this.runs.delete(runId);
  }
}
```

The store contains normalized report metadata only. Do not add fields for root URIs, generated content, elicited values, or arbitrary callback payloads.

- [ ] **Step 4: Run focused report and store tests**

Run:

```powershell
npx vitest run test/capabilityReport.test.ts test/capabilityRuns.test.ts
```

Expected: 10 tests PASS.

- [ ] **Step 5: Commit run state**

```powershell
git add src\server\capabilityRuns.ts test\capabilityRuns.test.ts
git commit -m "feat: add bounded capability run state" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 7209fade-87bf-4294-81fb-0d4b01bd52f4"
```

### Task 3: Normalize client capabilities and probe roots/basic sampling

**Files:**
- Create: `src/server/capabilityProbes.ts`
- Create: `test/capabilityProbes.test.ts`

- [ ] **Step 1: Write failing normalization, roots, and sampling tests**

Use a narrow fake client boundary so malformed responses can be tested without a transport:

```ts
import { describe, expect, it } from "vitest";
import type {
  ClientCapabilities,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
  ElicitResult,
  Implementation,
  ListRootsResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createInitialCapabilityReport,
  runBasicSamplingProbe,
  runRootsProbe,
  type CapabilityProbeClient,
} from "../src/server/capabilityProbes.js";
import { CapabilityRunStore } from "../src/server/capabilityRuns.js";

function client(overrides: Partial<CapabilityProbeClient> = {}): CapabilityProbeClient {
  return {
    listRoots: async (): Promise<ListRootsResult> => ({ roots: [] }),
    createMessage: async (): Promise<CreateMessageResult> => ({
      role: "assistant",
      model: "test",
      content: { type: "text", text: "ok" },
    }),
    elicitInput: async (): Promise<ElicitResult> => ({ action: "decline" }),
    ...overrides,
  };
}

describe("capability normalization", () => {
  it("treats an empty elicitation object as form support", () => {
    const report = createInitialCapabilityReport(
      "run",
      { elicitation: {} } as ClientCapabilities,
      { name: "client", version: "1" } as Implementation,
    );
    expect(report.advertised.elicitation).toEqual({ form: true, url: false });
    expect(report.probes.elicitationForm.status).toBe("pending");
  });

  it("copies only known task booleans and extension IDs", () => {
    const report = createInitialCapabilityReport(
      "run",
      {
        tasks: { list: {}, cancel: {}, requests: { sampling: { createMessage: {} } } },
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"], secret: "drop-me" },
          "vendor.example/feature": { token: "drop-me" },
        },
      },
      { name: "client", version: "1" },
    );
    expect(report.advertised.tasks).toEqual({
      list: true,
      cancel: true,
      samplingCreateMessage: true,
      elicitationCreate: false,
    });
    expect(report.advertised.extensionIds).toEqual([
      "io.modelcontextprotocol/ui",
      "vendor.example/feature",
    ]);
    expect(JSON.stringify(report)).not.toContain("drop-me");
  });
});

describe("roots and basic sampling probes", () => {
  it("retains root count/schemes/name presence but not root paths", async () => {
    const store = new CapabilityRunStore();
    store.create(
      createInitialCapabilityReport("run", { roots: {} }, { name: "client", version: "1" }),
    );
    await runRootsProbe(
      client({
        listRoots: async () => ({
          roots: [{ uri: "file:///private/secret", name: "Workspace" }],
        }),
      }),
      store,
      "run",
      { machineMs: 50 },
    );
    const report = store.report("run");
    expect(report.probes.roots).toMatchObject({ status: "passed" });
    expect(report.probes.roots.detail).toContain("count=1");
    expect(JSON.stringify(report)).not.toContain("/private/secret");
  });

  it("fails roots when a returned URI is not file:", async () => {
    const store = new CapabilityRunStore();
    store.create(
      createInitialCapabilityReport("run", { roots: {} }, { name: "client", version: "1" }),
    );
    await runRootsProbe(
      client({ listRoots: async () => ({ roots: [{ uri: "https://example.com/root" }] }) }),
      store,
      "run",
      { machineMs: 50 },
    );
    expect(store.report("run").probes.roots).toMatchObject({
      status: "failed",
      errorCode: "invalid_root_uri",
    });
  });

  it("passes basic sampling and discards model output", async () => {
    const store = new CapabilityRunStore();
    store.create(
      createInitialCapabilityReport("run", { sampling: {} }, { name: "client", version: "1" }),
    );
    await runBasicSamplingProbe(
      client({
        createMessage: async (_params: CreateMessageRequest["params"]) => ({
          role: "assistant",
          model: "private-model-name",
          content: { type: "text", text: "private generated text" },
        }),
      }),
      store,
      "run",
      { samplingMs: 50 },
    );
    const report = store.report("run");
    expect(report.probes.samplingBasic).toMatchObject({ status: "passed" });
    expect(JSON.stringify(report)).not.toContain("private generated text");
    expect(JSON.stringify(report)).not.toContain("private-model-name");
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
npx vitest run test/capabilityProbes.test.ts
```

Expected: FAIL because `capabilityProbes.ts` does not exist.

- [ ] **Step 3: Implement capability normalization and initial statuses**

In `src/server/capabilityProbes.ts`, define constants and helpers:

```ts
import { LATEST_PROTOCOL_VERSION, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type {
  ClientCapabilities,
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
  ElicitRequest,
  ElicitResult,
  Implementation,
  ListRootsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { CapabilityRunStore } from "./capabilityRuns.js";
import {
  PROBE_KEYS,
  type CapabilityProbeResult,
  type CapabilityReport,
  type ProbeKey,
} from "./capabilityReport.js";

export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_APPS_MIME_TYPE = "text/html;profile=mcp-app";

export interface CapabilityProbeClient {
  listRoots(options?: RequestOptions): Promise<ListRootsResult>;
  createMessage(
    params: CreateMessageRequest["params"],
    options?: RequestOptions,
  ): Promise<CreateMessageResult | CreateMessageResultWithTools>;
  elicitInput(
    params: ElicitRequest["params"],
    options?: RequestOptions,
  ): Promise<ElicitResult>;
}

export interface CapabilityProbeTimeouts {
  machineMs: number;
  samplingMs: number;
  elicitationMs: number;
}

export const DEFAULT_PROBE_TIMEOUTS: CapabilityProbeTimeouts = {
  machineMs: 15_000,
  samplingMs: 5 * 60_000,
  elicitationMs: 10 * 60_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pending(advertised = true): CapabilityProbeResult {
  return { status: "pending", advertised };
}

function unsupported(advertised = false, detail?: string): CapabilityProbeResult {
  return { status: "unsupported", advertised, ...(detail ? { detail } : {}) };
}

export function createInitialCapabilityReport(
  runId: string,
  capabilities: ClientCapabilities,
  client: Implementation | undefined,
): CapabilityReport {
  const extensionIds = Object.keys(capabilities.extensions ?? {}).sort();
  const uiRaw = capabilities.extensions?.[MCP_APPS_EXTENSION_ID];
  const ui = isRecord(uiRaw) ? uiRaw : undefined;
  const mimeTypes = Array.isArray(ui?.mimeTypes)
    ? ui.mimeTypes.filter((value): value is string => typeof value === "string")
    : undefined;
  const uiAdvertised = Object.prototype.hasOwnProperty.call(
    capabilities.extensions ?? {},
    MCP_APPS_EXTENSION_ID,
  );
  const uiCompatible = uiAdvertised && ui !== undefined &&
    (mimeTypes === undefined || mimeTypes.includes(MCP_APPS_MIME_TYPE));
  const elicitation = capabilities.elicitation;
  const form = elicitation !== undefined &&
    (elicitation.form !== undefined || Object.keys(elicitation).length === 0);
  const url = elicitation?.url !== undefined;
  const probes = Object.fromEntries(
    PROBE_KEYS.map((key) => [key, unsupported()]),
  ) as CapabilityReport["probes"];

  probes.roots = capabilities.roots ? pending() : unsupported();
  probes.rootsListChanged = capabilities.roots?.listChanged
    ? { status: "advertised_only", advertised: true, detail: "Notification advertised; workspace mutation not performed." }
    : unsupported();
  probes.samplingBasic = capabilities.sampling ? pending() : unsupported();
  probes.samplingTools = capabilities.sampling?.tools ? pending() : unsupported();
  probes.elicitationForm = form ? pending() : unsupported();
  probes.elicitationUrl = url ? pending() : unsupported();
  for (const key of ["mcpAppsRender", "mcpAppsTheme", "mcpAppsResize", "mcpAppsServerCall"] as const) {
    probes[key] = uiCompatible
      ? pending(true)
      : unsupported(uiAdvertised, uiAdvertised ? "MCP Apps MIME type is incompatible." : undefined);
  }
  for (const key of ["legacyTaskCreate", "legacyTaskPoll", "legacyTaskInputRequired", "legacyTaskResult", "legacyTaskCancel"] as const) {
    probes[key] = { status: "not_exercised" };
  }
  probes.modernProtocol = {
    status: "not_exercised",
    detail: "SDK v1 tests the 2025 protocol generation; modern MRTR requires SDK v2.",
  };
  probes.tasksExtension = {
    status: "not_exercised",
    advertised: extensionIds.includes("io.modelcontextprotocol/tasks"),
    detail: "The modern Tasks extension is not implemented by SDK v1.",
  };

  return {
    runId,
    overall: Object.values(probes).some((probe) => probe.status === "pending") ? "pending" : "complete",
    client: {
      ...(client?.name ? { name: client.name } : {}),
      ...(client?.version ? { version: client.version } : {}),
      protocolVersion: LATEST_PROTOCOL_VERSION,
    },
    advertised: {
      capabilityKeys: Object.keys(capabilities).sort(),
      extensionIds,
      ...(capabilities.roots
        ? { roots: { listChanged: capabilities.roots.listChanged ?? false } }
        : {}),
      ...(capabilities.sampling
        ? {
            sampling: {
              context: capabilities.sampling.context !== undefined,
              tools: capabilities.sampling.tools !== undefined,
            },
          }
        : {}),
      ...(capabilities.elicitation
        ? { elicitation: { form, url } }
        : {}),
      ...(capabilities.tasks
        ? {
            tasks: {
              list: capabilities.tasks.list !== undefined,
              cancel: capabilities.tasks.cancel !== undefined,
              samplingCreateMessage:
                capabilities.tasks.requests?.sampling?.createMessage !== undefined,
              elicitationCreate:
                capabilities.tasks.requests?.elicitation?.create !== undefined,
            },
          }
        : {}),
    },
    probes,
    nextActions: [],
  };
}
```

- [ ] **Step 4: Implement roots/basic sampling with fixed error classification**

Add these helpers and probes to the same file:

```ts
function duration(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function fixedFailure(error: unknown, interactive: boolean): CapabilityProbeResult {
  const message = error instanceof Error ? error.message : "";
  if (interactive && /reject|declin|cancel|denied|not approved/i.test(message)) {
    return {
      status: "supported_not_completed",
      detail: "Client declined or cancelled the interactive request.",
      errorCode: error instanceof McpError ? String(error.code) : "declined",
    };
  }
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return { status: "failed", detail: "Client request timed out.", errorCode: "request_timeout" };
  }
  if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) {
    return { status: "failed", detail: "Advertised method was not implemented.", errorCode: "method_not_found" };
  }
  return {
    status: "failed",
    detail: "Client returned a protocol or validation error.",
    errorCode: error instanceof McpError ? String(error.code) : error instanceof Error ? error.name : "unknown",
  };
}

export async function runRootsProbe(
  client: CapabilityProbeClient,
  runs: CapabilityRunStore,
  runId: string,
  timeouts: Pick<CapabilityProbeTimeouts, "machineMs">,
  relatedTask?: { taskId: string },
): Promise<void> {
  if (runs.report(runId).probes.roots.status !== "pending") return;
  const startedAt = Date.now();
  try {
    const result = await client.listRoots({
      timeout: timeouts.machineMs,
      signal: runs.signal(runId),
      ...(relatedTask ? { relatedTask } : {}),
    });
    const schemes = new Set<string>();
    let named = false;
    for (const root of result.roots) {
      const uri = new URL(root.uri);
      if (uri.protocol !== "file:") {
        runs.updateProbe(runId, "roots", {
          status: "failed",
          advertised: true,
          durationMs: duration(startedAt),
          detail: "Client returned a root outside the allowed file scheme.",
          errorCode: "invalid_root_uri",
        });
        return;
      }
      schemes.add(uri.protocol.slice(0, -1));
      named ||= typeof root.name === "string" && root.name.length > 0;
    }
    runs.updateProbe(runId, "roots", {
      status: "passed",
      advertised: true,
      durationMs: duration(startedAt),
      detail: `count=${result.roots.length}; schemes=${[...schemes].sort().join(",") || "none"}; displayNames=${named ? "yes" : "no"}`,
    });
  } catch (error) {
    runs.updateProbe(runId, "roots", {
      ...fixedFailure(error, false),
      advertised: true,
      durationMs: duration(startedAt),
    });
  }
}

export async function runBasicSamplingProbe(
  client: CapabilityProbeClient,
  runs: CapabilityRunStore,
  runId: string,
  timeouts: Pick<CapabilityProbeTimeouts, "samplingMs">,
  relatedTask?: { taskId: string },
): Promise<void> {
  if (runs.report(runId).probes.samplingBasic.status !== "pending") return;
  const startedAt = Date.now();
  try {
    const result = await client.createMessage(
      {
        messages: [{
          role: "user",
          content: { type: "text", text: "Reply with one short acknowledgement for an MCP capability test." },
        }],
        includeContext: "none",
        maxTokens: 32,
      },
      {
        timeout: timeouts.samplingMs,
        signal: runs.signal(runId),
        ...(relatedTask ? { relatedTask } : {}),
      },
    );
    const blocks = Array.isArray(result.content) ? result.content : [result.content];
    const hasText = result.role === "assistant" &&
      blocks.some((block) => block.type === "text" && block.text.trim().length > 0);
    runs.updateProbe(runId, "samplingBasic", hasText
      ? {
          status: "passed",
          advertised: true,
          durationMs: duration(startedAt),
          detail: `assistantText=yes; modelField=${result.model ? "present" : "absent"}`,
        }
      : {
          status: "failed",
          advertised: true,
          durationMs: duration(startedAt),
          detail: "Client returned no non-empty assistant text.",
          errorCode: "invalid_sampling_result",
        });
  } catch (error) {
    runs.updateProbe(runId, "samplingBasic", {
      ...fixedFailure(error, true),
      advertised: true,
      durationMs: duration(startedAt),
    });
  }
}
```

- [ ] **Step 5: Run the focused tests**

Run:

```powershell
npx vitest run test/capabilityReport.test.ts test/capabilityRuns.test.ts test/capabilityProbes.test.ts
```

Expected: all report, run-store, roots, and basic sampling tests PASS.

- [ ] **Step 6: Commit the first probes**

```powershell
git add src\server\capabilityProbes.ts test\capabilityProbes.test.ts
git commit -m "feat: probe roots and basic sampling" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 7209fade-87bf-4294-81fb-0d4b01bd52f4"
```

### Task 4: Add sampling-tools and elicitation probes

**Files:**
- Modify: `src/server/capabilityProbes.ts`
- Modify: `test/capabilityProbes.test.ts`

- [ ] **Step 1: Add failing sampling-tools tests**

Add cases that require one valid `capability_echo` call and reject duplicate/unknown tool IDs:

```ts
it("completes the sampling tool loop without retaining tool inputs", async () => {
  const store = new CapabilityRunStore();
  store.create(
    createInitialCapabilityReport(
      "run",
      { sampling: { tools: {} } },
      { name: "client", version: "1" },
    ),
  );
  let call = 0;
  await runSamplingToolsProbe(
    client({
      createMessage: async () => {
        call += 1;
        return call === 1
          ? {
              role: "assistant",
              model: "test",
              stopReason: "toolUse",
              content: [{
                type: "tool_use",
                name: "capability_echo",
                id: "tool-1",
                input: { value: "private-input" },
              }],
            }
          : {
              role: "assistant",
              model: "test",
              stopReason: "endTurn",
              content: [{ type: "text", text: "done" }],
            };
      },
    }),
    store,
    "run",
    { samplingMs: 50 },
  );
  const report = store.report("run");
  expect(report.probes.samplingTools.status).toBe("passed");
  expect(JSON.stringify(report)).not.toContain("private-input");
});

it("fails sampling tools when tool-use IDs are duplicated", async () => {
  const store = new CapabilityRunStore();
  store.create(
    createInitialCapabilityReport(
      "run",
      { sampling: { tools: {} } },
      { name: "client", version: "1" },
    ),
  );
  await runSamplingToolsProbe(
    client({
      createMessage: async () => ({
        role: "assistant",
        model: "test",
        stopReason: "toolUse",
        content: [
          { type: "tool_use", name: "capability_echo", id: "dup", input: {} },
          { type: "tool_use", name: "capability_echo", id: "dup", input: {} },
        ],
      }),
    }),
    store,
    "run",
    { samplingMs: 50 },
  );
  expect(store.report("run").probes.samplingTools).toMatchObject({
    status: "failed",
    errorCode: "invalid_tool_use",
  });
});
```

- [ ] **Step 2: Add failing form/URL elicitation tests**

Add accept, decline, cancel, and no-retention cases:

```ts
it.each(["decline", "cancel"] as const)(
  "treats form elicitation %s as supported but not completed",
  async (action) => {
    const store = new CapabilityRunStore();
    store.create(
      createInitialCapabilityReport(
        "run",
        { elicitation: { form: {} } },
        { name: "client", version: "1" },
      ),
    );
    await runFormElicitationProbe(
      client({ elicitInput: async () => ({ action }) }),
      store,
      "run",
      { elicitationMs: 50 },
    );
    expect(store.report("run").probes.elicitationForm.status).toBe(
      "supported_not_completed",
    );
  },
);

it("passes accepted form elicitation without retaining the value", async () => {
  const store = new CapabilityRunStore();
  store.create(
    createInitialCapabilityReport(
      "run",
      { elicitation: { form: {} } },
      { name: "client", version: "1" },
    ),
  );
  await runFormElicitationProbe(
    client({ elicitInput: async () => ({ action: "accept", content: { confirmed: true } }) }),
    store,
    "run",
    { elicitationMs: 50 },
  );
  expect(store.report("run").probes.elicitationForm.status).toBe("passed");
  expect(JSON.stringify(store.report("run"))).not.toContain("confirmed");
});

it("fails accepted form elicitation with invalid content", async () => {
  const store = new CapabilityRunStore();
  store.create(
    createInitialCapabilityReport(
      "run",
      { elicitation: { form: {} } },
      { name: "client", version: "1" },
    ),
  );
  await runFormElicitationProbe(
    client({
      elicitInput: async () => ({
        action: "accept",
        content: { confirmed: "yes" },
      }) as unknown as ElicitResult,
    }),
    store,
    "run",
    { elicitationMs: 50 },
  );
  expect(store.report("run").probes.elicitationForm).toMatchObject({
    status: "failed",
    errorCode: "invalid_elicitation_result",
  });
});

it("passes accepted URL elicitation and uses the reserved domain", async () => {
  let request: ElicitRequest["params"] | undefined;
  const store = new CapabilityRunStore();
  store.create(
    createInitialCapabilityReport(
      "run-id",
      { elicitation: { url: {} } },
      { name: "client", version: "1" },
    ),
  );
  await runUrlElicitationProbe(
    client({
      elicitInput: async (params) => {
        request = params;
        return { action: "accept" };
      },
    }),
    store,
    "run-id",
    { elicitationMs: 50 },
  );
  expect(request).toMatchObject({
    mode: "url",
    elicitationId: "capabilities-run-id",
    url: "https://example.invalid/open-knowledge-hub/capabilities/run-id",
  });
  expect(store.report("run-id").probes.elicitationUrl.status).toBe("passed");
});
```

- [ ] **Step 3: Run the focused test and verify new failures**

Run:

```powershell
npx vitest run test/capabilityProbes.test.ts
```

Expected: FAIL because the three new probe functions are not exported.

- [ ] **Step 4: Implement sampling with tools**

Add `runSamplingToolsProbe` using this exact synthetic tool and validation:

```ts
const CAPABILITY_ECHO_TOOL = {
  name: "capability_echo",
  description: "Echo one object to verify sampling tool use.",
  inputSchema: {
    type: "object" as const,
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

export async function runSamplingToolsProbe(
  client: CapabilityProbeClient,
  runs: CapabilityRunStore,
  runId: string,
  timeouts: Pick<CapabilityProbeTimeouts, "samplingMs">,
  relatedTask?: { taskId: string },
): Promise<void> {
  if (runs.report(runId).probes.samplingTools.status !== "pending") return;
  const startedAt = Date.now();
  const options: RequestOptions = {
    timeout: timeouts.samplingMs,
    signal: runs.signal(runId),
    ...(relatedTask ? { relatedTask } : {}),
  };
  const userMessage = {
    role: "user" as const,
    content: {
      type: "text" as const,
      text: "Call capability_echo exactly once with an object containing value, then summarize success.",
    },
  };
  try {
    const first = await client.createMessage(
      {
        messages: [userMessage],
        includeContext: "none",
        maxTokens: 64,
        tools: [CAPABILITY_ECHO_TOOL],
        toolChoice: { mode: "required" },
      },
      options,
    );
    const firstBlocks = Array.isArray(first.content) ? first.content : [first.content];
    const uses = firstBlocks.filter(
      (block): block is Extract<(typeof firstBlocks)[number], { type: "tool_use" }> =>
        block.type === "tool_use",
    );
    const ids = new Set(uses.map((use) => use.id));
    const valid = uses.length > 0 &&
      ids.size === uses.length &&
      uses.every(
        (use) =>
          use.name === CAPABILITY_ECHO_TOOL.name &&
          isRecord(use.input),
      );
    if (!valid) {
      runs.updateProbe(runId, "samplingTools", {
        status: "failed",
        advertised: true,
        durationMs: duration(startedAt),
        detail: "Client returned invalid or duplicate tool-use blocks.",
        errorCode: "invalid_tool_use",
      });
      return;
    }
    const toolResults = uses.map((use) => ({
      type: "tool_result" as const,
      toolUseId: use.id,
      content: [{ type: "text" as const, text: "capability_echo completed" }],
    }));
    const final = await client.createMessage(
      {
        messages: [
          userMessage,
          { role: "assistant", content: first.content },
          { role: "user", content: toolResults },
        ],
        includeContext: "none",
        maxTokens: 64,
        tools: [CAPABILITY_ECHO_TOOL],
        toolChoice: { mode: "none" },
      },
      options,
    );
    const finalBlocks = Array.isArray(final.content) ? final.content : [final.content];
    const hasText = final.role === "assistant" &&
      finalBlocks.some((block) => block.type === "text" && block.text.trim().length > 0);
    runs.updateProbe(runId, "samplingTools", hasText
      ? {
          status: "passed",
          advertised: true,
          durationMs: duration(startedAt),
          detail: `toolUses=${uses.length}; idsMatched=yes; finalAssistantText=yes`,
        }
      : {
          status: "failed",
          advertised: true,
          durationMs: duration(startedAt),
          detail: "Tool loop completed without final assistant text.",
          errorCode: "invalid_sampling_result",
        });
  } catch (error) {
    runs.updateProbe(runId, "samplingTools", {
      ...fixedFailure(error, true),
      advertised: true,
      durationMs: duration(startedAt),
    });
  }
}
```

- [ ] **Step 5: Implement form and URL elicitation**

Add both probes with fixed messages and no retained content:

```ts
function elicitationResult(
  action: ElicitResult["action"],
  durationMs: number,
): CapabilityProbeResult {
  return action === "accept"
    ? { status: "passed", advertised: true, durationMs, detail: "Client completed the elicitation interaction." }
    : {
        status: "supported_not_completed",
        advertised: true,
        durationMs,
        detail: "Client presented the interaction; the user declined or cancelled.",
      };
}

export async function runFormElicitationProbe(
  client: CapabilityProbeClient,
  runs: CapabilityRunStore,
  runId: string,
  timeouts: Pick<CapabilityProbeTimeouts, "elicitationMs">,
  relatedTask?: { taskId: string },
): Promise<void> {
  if (runs.report(runId).probes.elicitationForm.status !== "pending") return;
  const startedAt = Date.now();
  try {
    const result = await client.elicitInput(
      {
        mode: "form",
        message: "Confirm this MCP client capability test.",
        requestedSchema: {
          type: "object",
          properties: {
            confirmed: {
              type: "boolean",
              title: "Confirm capability test",
            },
          },
          required: ["confirmed"],
        },
      },
      {
        timeout: timeouts.elicitationMs,
        signal: runs.signal(runId),
        ...(relatedTask ? { relatedTask } : {}),
      },
    );
    if (
      result.action === "accept" &&
      typeof result.content?.confirmed !== "boolean"
    ) {
      runs.updateProbe(runId, "elicitationForm", {
        status: "failed",
        advertised: true,
        durationMs: duration(startedAt),
        detail: "Client accepted form elicitation with invalid content.",
        errorCode: "invalid_elicitation_result",
      });
      return;
    }
    runs.updateProbe(
      runId,
      "elicitationForm",
      elicitationResult(result.action, duration(startedAt)),
    );
  } catch (error) {
    runs.updateProbe(runId, "elicitationForm", {
      ...fixedFailure(error, true),
      advertised: true,
      durationMs: duration(startedAt),
    });
  }
}

export async function runUrlElicitationProbe(
  client: CapabilityProbeClient,
  runs: CapabilityRunStore,
  runId: string,
  timeouts: Pick<CapabilityProbeTimeouts, "elicitationMs">,
  relatedTask?: { taskId: string },
): Promise<void> {
  if (runs.report(runId).probes.elicitationUrl.status !== "pending") return;
  const startedAt = Date.now();
  try {
    const result = await client.elicitInput(
      {
        mode: "url",
        message: "Open this reserved URL to confirm URL elicitation support.",
        elicitationId: `capabilities-${runId}`,
        url: `https://example.invalid/open-knowledge-hub/capabilities/${encodeURIComponent(runId)}`,
      },
      {
        timeout: timeouts.elicitationMs,
        signal: runs.signal(runId),
        ...(relatedTask ? { relatedTask } : {}),
      },
    );
    runs.updateProbe(
      runId,
      "elicitationUrl",
      elicitationResult(result.action, duration(startedAt)),
    );
  } catch (error) {
    runs.updateProbe(runId, "elicitationUrl", {
      ...fixedFailure(error, true),
      advertised: true,
      durationMs: duration(startedAt),
    });
  }
}
```

- [ ] **Step 6: Add the sequential runner**

Export one runner that prevents overlapping consent prompts:

```ts
export interface CapabilityTaskProbeContext {
  taskId: string;
  setInputRequired(): Promise<void>;
  setWorking(): Promise<void>;
}

export async function runCapabilityProbes(
  client: CapabilityProbeClient,
  runs: CapabilityRunStore,
  runId: string,
  timeouts: CapabilityProbeTimeouts,
  task?: CapabilityTaskProbeContext,
): Promise<void> {
  const relatedTask = task ? { taskId: task.taskId } : undefined;
  await runRootsProbe(client, runs, runId, timeouts, relatedTask);
  await runInteractiveProbe("samplingBasic", task, runs, runId, () =>
    runBasicSamplingProbe(client, runs, runId, timeouts, relatedTask));
  await runInteractiveProbe("samplingTools", task, runs, runId, () =>
    runSamplingToolsProbe(client, runs, runId, timeouts, relatedTask));
  await runInteractiveProbe("elicitationForm", task, runs, runId, () =>
    runFormElicitationProbe(client, runs, runId, timeouts, relatedTask));
  await runInteractiveProbe("elicitationUrl", task, runs, runId, () =>
    runUrlElicitationProbe(client, runs, runId, timeouts, relatedTask));
}

async function runInteractiveProbe(
  key: "samplingBasic" | "samplingTools" | "elicitationForm" | "elicitationUrl",
  task: CapabilityTaskProbeContext | undefined,
  runs: CapabilityRunStore,
  runId: string,
  run: () => Promise<void>,
): Promise<void> {
  if (runs.report(runId).probes[key].status !== "pending") return;
  if (!task) {
    await run();
    return;
  }
  await task.setInputRequired();
  try {
    await run();
  } finally {
    await task.setWorking();
  }
}
```

The task adapter is only passed when at least one sampling or elicitation probe is pending. Roots never sets `input_required`.

- [ ] **Step 7: Run probe tests and commit**

Run:

```powershell
npx vitest run test/capabilityProbes.test.ts
```

Expected: all capability-probe tests PASS.

Commit:

```powershell
git add src\server\capabilityProbes.ts test\capabilityProbes.test.ts
git commit -m "feat: probe sampling tools and elicitation" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 7209fade-87bf-4294-81fb-0d4b01bd52f4"
```

### Task 5: Observe legacy Tasks without counting SDK auto-polling

**Files:**
- Create: `src/server/capabilityTaskStore.ts`
- Create: `test/capabilityTaskStore.test.ts`

- [ ] **Step 1: Write failing task-store observation tests**

Use `InMemoryTaskStore` as the delegate and a real `CallToolRequest`:

```ts
import { describe, expect, it } from "vitest";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type { CallToolRequest, Result } from "@modelcontextprotocol/sdk/types.js";
import { CapabilityTaskStore } from "../src/server/capabilityTaskStore.js";
import { CapabilityRunStore } from "../src/server/capabilityRuns.js";
import { createInitialCapabilityReport } from "../src/server/capabilityProbes.js";

function request(taskAugmented: boolean): CallToolRequest {
  return {
    method: "tools/call",
    params: {
      name: "capabilities",
      arguments: {},
      ...(taskAugmented ? { task: { ttl: 1_000 } } : {}),
    },
  };
}

describe("CapabilityTaskStore", () => {
  it("marks create/poll/result only for a task-augmented call", async () => {
    const runs = new CapabilityRunStore();
    runs.create(createInitialCapabilityReport("run", {}, { name: "client", version: "1" }));
    const delegate = new InMemoryTaskStore();
    const store = new CapabilityTaskStore(delegate, runs, (runId) => ({
      content: [{ type: "text", text: runId }],
      structuredContent: runs.report(runId),
    }));
    const task = await store.createTask(
      { ttl: 1_000, pollInterval: 5, context: { kind: "capabilities", runId: "run", action: "scan" } },
      1,
      request(true),
    );
    expect(runs.report("run").probes.legacyTaskCreate.status).toBe("passed");
    await store.getTask(task.taskId);
    expect(runs.report("run").probes.legacyTaskPoll.status).toBe("pending");
    store.markPolled(task.taskId);
    expect(runs.report("run").probes.legacyTaskPoll.status).toBe("passed");
    await store.storeTaskResult(task.taskId, "completed", { value: "stale" } as Result);
    const result = store.markResultRequested(task.taskId);
    expect(runs.report("run").probes.legacyTaskResult.status).toBe("passed");
    expect(result).toMatchObject({ structuredContent: { runId: "run" } });
    delegate.cleanup();
  });

  it("does not count optional-tool auto-polling for a normal call", async () => {
    const runs = new CapabilityRunStore();
    runs.create(createInitialCapabilityReport("run", {}, { name: "client", version: "1" }));
    const delegate = new InMemoryTaskStore();
    const store = new CapabilityTaskStore(delegate, runs, () => ({ value: "result" }));
    const task = await store.createTask(
      { ttl: 1_000, context: { kind: "capabilities", runId: "run", action: "scan" } },
      1,
      request(false),
    );
    store.markPolled(task.taskId);
    await store.storeTaskResult(task.taskId, "completed", { value: "result" });
    store.markResultRequested(task.taskId);
    expect(runs.report("run").probes.legacyTaskCreate.status).toBe("not_exercised");
    expect(runs.report("run").probes.legacyTaskPoll.status).toBe("not_exercised");
    expect(runs.report("run").probes.legacyTaskResult.status).toBe("not_exercised");
    delegate.cleanup();
  });

  it("records cancellation and aborts the diagnostic run", async () => {
    const runs = new CapabilityRunStore();
    const run = runs.create(createInitialCapabilityReport("run", {}, { name: "client", version: "1" }));
    const delegate = new InMemoryTaskStore();
    const store = new CapabilityTaskStore(delegate, runs, () => ({ value: "result" }));
    const task = await store.createTask(
      { ttl: 1_000, context: { kind: "capabilities", runId: "run", action: "task_cancel" } },
      1,
      request(true),
    );
    await store.updateTaskStatus(task.taskId, "cancelled");
    expect(runs.report("run").probes.legacyTaskCancel.status).toBe("passed");
    expect(run.signal.aborted).toBe(true);
    delegate.cleanup();
  });
});
```

- [ ] **Step 2: Run the task-store test and verify failure**

Run:

```powershell
npx vitest run test/capabilityTaskStore.test.ts
```

Expected: FAIL because `CapabilityTaskStore` does not exist.

- [ ] **Step 3: Implement task binding and observation**

Create `src/server/capabilityTaskStore.ts`:

```ts
import type {
  Request,
  RequestId,
  Result,
  Task,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CreateTaskOptions,
  TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CapabilityRunStore } from "./capabilityRuns.js";

interface CapabilityTaskContext {
  kind: "capabilities";
  runId: string;
  action: "scan" | "app_report" | "task_cancel" | "report";
}

interface TaskBinding extends CapabilityTaskContext {
  taskAugmented: boolean;
}

function capabilityContext(value: unknown): CapabilityTaskContext | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const context = value as Record<string, unknown>;
  if (
    context.kind !== "capabilities" ||
    typeof context.runId !== "string" ||
    !["scan", "app_report", "task_cancel", "report"].includes(String(context.action))
  ) {
    return undefined;
  }
  return {
    kind: "capabilities",
    runId: context.runId,
    action: context.action as CapabilityTaskContext["action"],
  };
}

export class CapabilityTaskStore implements TaskStore {
  private readonly bindings = new Map<string, TaskBinding>();

  constructor(
    private readonly delegate: TaskStore,
    private readonly runs: CapabilityRunStore,
    private readonly renderResult: (runId: string) => Result,
  ) {}

  async createTask(
    options: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    sessionId?: string,
  ): Promise<Task> {
    const task = await this.delegate.createTask(options, requestId, request, sessionId);
    const context = capabilityContext(options.context);
    if (!context) return task;
    const parsed = CallToolRequestSchema.safeParse(request);
    const taskAugmented = parsed.success && parsed.data.params.task !== undefined;
    this.bindings.set(task.taskId, { ...context, taskAugmented });
    if (taskAugmented && context.action === "scan") {
      this.runs.replaceProbe(context.runId, "legacyTaskCreate", {
        status: "passed",
        detail: "Client created a task-augmented tool call.",
      });
      this.runs.replaceProbe(context.runId, "legacyTaskPoll", { status: "pending" });
      this.runs.replaceProbe(context.runId, "legacyTaskResult", { status: "pending" });
    }
    if (taskAugmented && context.action === "task_cancel") {
      this.runs.replaceProbe(context.runId, "legacyTaskCancel", { status: "pending" });
    }
    return task;
  }

  async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    return this.delegate.getTask(taskId, sessionId);
  }

  async storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    await this.delegate.storeTaskResult(taskId, status, result, sessionId);
  }

  async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    return this.delegate.getTaskResult(taskId, sessionId);
  }

  async updateTaskStatus(
    taskId: string,
    status: Task["status"],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await this.delegate.updateTaskStatus(taskId, status, statusMessage, sessionId);
    const binding = this.bindings.get(taskId);
    if (
      status === "input_required" &&
      binding?.taskAugmented &&
      binding.action === "scan"
    ) {
      this.runs.replaceProbe(binding.runId, "legacyTaskInputRequired", {
        status: "passed",
        detail: "Task entered input_required before sampling or elicitation.",
      });
    }
    if (
      status === "cancelled" &&
      binding?.taskAugmented &&
      binding.action === "task_cancel"
    ) {
      this.runs.replaceProbe(binding.runId, "legacyTaskCancel", {
        status: "passed",
        detail: "Client cancelled the diagnostic task.",
      });
      this.runs.abort(binding.runId);
    }
  }

  listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    return this.delegate.listTasks(cursor, sessionId);
  }

  isTaskAugmented(taskId: string): boolean {
    return this.bindings.get(taskId)?.taskAugmented ?? false;
  }

  markPolled(taskId: string): void {
    const binding = this.bindings.get(taskId);
    if (!binding?.taskAugmented || binding.action !== "scan") return;
    this.runs.replaceProbe(binding.runId, "legacyTaskPoll", {
      status: "passed",
      detail: "Client retrieved task status.",
    });
  }

  markResultRequested(taskId: string): Result | undefined {
    const binding = this.bindings.get(taskId);
    if (!binding?.taskAugmented || binding.action !== "scan") return undefined;
    if (this.runs.report(binding.runId).probes.legacyTaskPoll.status === "pending") {
      this.runs.replaceProbe(binding.runId, "legacyTaskPoll", {
        status: "supported_not_completed",
        detail: "Task result was retrieved without a preceding status poll.",
      });
    }
    this.runs.replaceProbe(binding.runId, "legacyTaskResult", {
      status: "passed",
      detail: "Client retrieved the completed task result.",
    });
    return this.renderResult(binding.runId);
  }

  cleanup(): void {
    this.bindings.clear();
    const candidate: unknown = this.delegate;
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "cleanup" in candidate &&
      typeof candidate.cleanup === "function"
    ) {
      candidate.cleanup();
    }
  }
}
```

The localized assertion in `capabilityContext` is only after runtime shape checks. Do not use `as any`.

- [ ] **Step 4: Add input-required and cancellation timeout helpers**

Add the cancellation timeout owned by this store so cleanup clears every timer:

```ts
private readonly cancellationTimers = new Map<string, NodeJS.Timeout>();

armCancellationTimeout(taskId: string, timeoutMs: number): void {
  const binding = this.bindings.get(taskId);
  if (!binding?.taskAugmented || binding.action !== "task_cancel") return;
  const timer = setTimeout(() => {
    this.cancellationTimers.delete(taskId);
    try {
      if (this.runs.report(binding.runId).probes.legacyTaskCancel.status === "pending") {
        this.runs.replaceProbe(binding.runId, "legacyTaskCancel", {
          status: "supported_not_completed",
          detail: "Cancellation task expired before the client sent tasks/cancel.",
        });
      }
    } catch {
      return;
    }
  }, timeoutMs);
  timer.unref();
  this.cancellationTimers.set(taskId, timer);
}
```

In `updateTaskStatus`, clear and delete `cancellationTimers.get(taskId)` before
recording `cancelled`. In `cleanup`, clear every remaining timer before clearing
bindings and cleaning up the delegate.

Use these exact additions:

```ts
if (status === "cancelled") {
  const timer = this.cancellationTimers.get(taskId);
  if (timer) clearTimeout(timer);
  this.cancellationTimers.delete(taskId);
}
```

```ts
cleanup(): void {
  for (const timer of this.cancellationTimers.values()) clearTimeout(timer);
  this.cancellationTimers.clear();
  this.bindings.clear();
  const candidate: unknown = this.delegate;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "cleanup" in candidate &&
    typeof candidate.cleanup === "function"
  ) {
    candidate.cleanup();
  }
}
```

- [ ] **Step 5: Run task-store tests**

Run:

```powershell
npx vitest run test/capabilityTaskStore.test.ts test/capabilityRuns.test.ts
```

Expected: all task-store and run-store tests PASS.

- [ ] **Step 6: Commit task observation**

```powershell
git add src\server\capabilityTaskStore.ts test\capabilityTaskStore.test.ts
git commit -m "feat: observe legacy task lifecycle" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 7209fade-87bf-4294-81fb-0d4b01bd52f4"
```

### Task 6: Register the tool, task runtime, and App resource

**Files:**
- Create: `src/server/capabilities.ts`
- Create: `resources/tool-meta/capabilities.md`
- Modify: `src/server/toolSchemas.ts:7-31`
- Modify: `src/server/index.ts:1-24`
- Modify: `test/server.test.ts:35-80`
- Create: `test/capabilities.test.ts`

- [ ] **Step 1: Add the failing schema/metadata/surface tests**

Add the raw shape:

```ts
const appProbeReport = z.object({
  initialized: z.literal(true),
  theme: z.enum(["provided", "absent"]),
  resize: z.enum(["observed", "fixed_container", "unobserved"]),
}).strict();

// inside toolShapes
capabilities: {
  action: z.enum(["scan", "app_report", "task_cancel", "report"]).optional(),
  runId: z.string().min(16).optional(),
  app: appProbeReport.optional(),
},
```

Create `resources/tool-meta/capabilities.md`:

```markdown
---
title: Test MCP client capabilities
args:
  action: Diagnostic action. Omit for scan; follow-ups use app_report, task_cancel, or report.
  runId: Run identifier returned by a previous scan.
  app: Fixed MCP App observations for app_report.
---
Actively test roots, sampling, elicitation, MCP Apps, and legacy Tasks. Returns the same normalized report as terminal text and structured content. Use the default scan unless following a run's explicit next action.
```

Update the exact tool assertion in `test/server.test.ts` to include `capabilities`, and add:

```ts
expect(tools).toEqual([
  "add_container",
  "add_module",
  "ask",
  "capabilities",
  "config",
  "context",
  "inspect",
  "onboard",
  "run",
  "sync",
]);
expect(client.getServerCapabilities()?.resources).toBeDefined();
expect(client.getServerCapabilities()?.tasks).toBeDefined();
expect(client.getServerCapabilities()?.extensions?.["io.modelcontextprotocol/ui"]).toEqual({
  mimeTypes: ["text/html;profile=mcp-app"],
});
```

Create the first `test/capabilities.test.ts` case:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer } from "../src/server/index.js";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import type { Gh } from "../src/git/gh.js";
import { makePaths, makeTempDir, testRun } from "./helpers.js";

const servers: McpServer[] = [];
const clients: Client[] = [];
const homes: string[] = [];

class FakeGh {
  async createRepo(): Promise<string> {
    return "x";
  }

  async createPr(): Promise<string> {
    return "x";
  }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    homes.splice(0).map(async (home) => {
      const { rm } = await import("node:fs/promises");
      await rm(home, { recursive: true, force: true });
    }),
  );
});

async function connect(capabilities = {}) {
  const home = await makeTempDir();
  homes.push(home);
  const paths = makePaths(home);
  const service = new ContainerService(
    paths,
    new Git(testRun),
    new FakeGh() as unknown as Gh,
  );
  const server = await buildServer({ paths, service });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "capability-test-client", version: "1" },
    { capabilities },
  );
  servers.push(server);
  clients.push(client);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function reportOf(result: Awaited<ReturnType<Client["callTool"]>>) {
  return (result as CallToolResult).structuredContent as {
    runId: string;
    overall: string;
    probes: Record<string, { status: string }>;
  };
}

describe("capabilities tool", () => {
  it("returns a terminal report when the client advertises no optional capabilities", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "capabilities", arguments: {} });
    const report = reportOf(result);
    expect(report.overall).toBe("complete");
    expect(report.probes.roots.status).toBe("unsupported");
    expect(report.probes.mcpAppsRender.status).toBe("unsupported");
    expect(report.probes.modernProtocol.status).toBe("not_exercised");
    expect(report.probes.legacyTaskCreate.status).toBe("not_exercised");
  });
});
```

- [ ] **Step 2: Run the targeted tests and verify failure**

Run:

```powershell
npx vitest run test/toolMeta.test.ts test/server.test.ts test/capabilities.test.ts
```

Expected: metadata passes only after the new resource exists; server/capabilities tests FAIL because registration and wiring are absent.

- [ ] **Step 3: Implement action validation and client identity**

Create the top of `src/server/capabilities.ts`:

```ts
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { CapabilityTaskStore } from "./capabilityTaskStore.js";
import type { CapabilityRunStore } from "./capabilityRuns.js";
import {
  DEFAULT_PROBE_TIMEOUTS,
  MCP_APPS_MIME_TYPE,
  createInitialCapabilityReport,
  runCapabilityProbes,
  type CapabilityProbeTimeouts,
} from "./capabilityProbes.js";
import { capabilityReportResult } from "./capabilityReport.js";
import { describeShape, loadToolMeta } from "./toolMeta.js";
import { toolShapes } from "./toolSchemas.js";

export const CAPABILITIES_APP_URI = "ui://open-knowledge-hub/capabilities";
const APP_ROOT = new URL("../../resources/apps/capabilities.html", import.meta.url);

export interface AppProbeReport {
  initialized: true;
  theme: "provided" | "absent";
  resize: "observed" | "fixed_container" | "unobserved";
}

export interface CapabilitiesArgs {
  action?: "scan" | "app_report" | "task_cancel" | "report";
  runId?: string;
  app?: AppProbeReport;
}

export interface CapabilityRegistrationOptions {
  runs: CapabilityRunStore;
  tasks: CapabilityTaskStore;
  timeouts?: Partial<CapabilityProbeTimeouts> & {
    cancellationTtlMs?: number;
    taskPollIntervalMs?: number;
  };
  runId?: () => string;
}

function invalid(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

function validateAction(args: CapabilitiesArgs): Required<Pick<CapabilitiesArgs, "action">> & CapabilitiesArgs {
  const action = args.action ?? "scan";
  if (action === "scan") {
    if (args.runId !== undefined || args.app !== undefined) {
      invalid("scan does not accept runId or app.");
    }
    return { action };
  }
  if (!args.runId) invalid(`${action} requires runId.`);
  if (action === "app_report" && !args.app) invalid("app_report requires app.");
  if (action !== "app_report" && args.app !== undefined) {
    invalid(`${action} does not accept app.`);
  }
  return { ...args, action };
}

function clientKey(
  server: McpServer,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): string | undefined {
  const client = server.server.getClientVersion();
  if (!client && !extra.sessionId) return undefined;
  return `${client?.name ?? "unknown"}@${client?.version ?? "unknown"}|${extra.sessionId ?? ""}`;
}
```

- [ ] **Step 4: Register the App resource**

Add:

```ts
async function registerCapabilitiesResource(server: McpServer): Promise<void> {
  const html = await readFile(fileURLToPath(APP_ROOT), "utf8");
  server.registerResource(
    "MCP Client Capabilities",
    CAPABILITIES_APP_URI,
    {
      title: "MCP Client Capabilities",
      description: "Interactive view of the normalized MCP client capability report.",
      mimeType: MCP_APPS_MIME_TYPE,
      _meta: { ui: { prefersBorder: true } },
    },
    async () => ({
      contents: [{
        uri: CAPABILITIES_APP_URI,
        mimeType: MCP_APPS_MIME_TYPE,
        text: html,
        _meta: { ui: { prefersBorder: true } },
      }],
    }),
  );
}
```

Create a bootstrap `resources/apps/capabilities.html` so resource loading can pass before Task 7:

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>MCP Client Capabilities</title></head>
<body><pre>Loading MCP client capabilities...</pre></body>
</html>
```

- [ ] **Step 5: Register the optional task tool and orchestrate actions**

Implement `registerCapabilities`:

```ts
export async function registerCapabilities(
  server: McpServer,
  options: CapabilityRegistrationOptions,
): Promise<void> {
  const meta = await loadToolMeta("capabilities");
  const timeouts = {
    ...DEFAULT_PROBE_TIMEOUTS,
    cancellationTtlMs: 5 * 60_000,
    taskPollIntervalMs: 500,
    ...options.timeouts,
  };
  const createRunId = options.runId ?? (() => randomBytes(16).toString("hex"));
  await registerCapabilitiesResource(server);

  server.experimental.tasks.registerToolTask(
    "capabilities",
    {
      title: meta.title,
      description: meta.description,
      inputSchema: describeShape(toolShapes.capabilities, meta.args),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      execution: { taskSupport: "optional" },
      _meta: {
        ui: {
          resourceUri: CAPABILITIES_APP_URI,
          visibility: ["model", "app"],
        },
        "ui/resourceUri": CAPABILITIES_APP_URI,
      },
    },
    {
      createTask: async (rawArgs, extra) => {
        const args = validateAction(rawArgs);
        const key = clientKey(server, extra);
        const runId = args.action === "scan" ? createRunId() : args.runId!;
        if (args.action === "scan") {
          const report = createInitialCapabilityReport(
            runId,
            server.server.getClientCapabilities() ?? {},
            server.server.getClientVersion(),
          );
          options.runs.create(report, key);
        } else {
          options.runs.report(runId, key);
        }
        const task = await extra.taskStore.createTask({
          ttl: args.action === "task_cancel" ? timeouts.cancellationTtlMs : 30 * 60_000,
          pollInterval: timeouts.taskPollIntervalMs,
          context: { kind: "capabilities", runId, action: args.action },
        });
        if (args.action === "scan") {
          extra.signal.addEventListener(
            "abort",
            () => options.runs.abort(runId),
            { once: true },
          );
        }

        const execute = async (): Promise<void> => {
          if (args.action === "scan") {
            const taskAugmented = options.tasks.isTaskAugmented(task.taskId);
            const report = options.runs.report(runId);
            const hasInteractive = [
              report.probes.samplingBasic,
              report.probes.samplingTools,
              report.probes.elicitationForm,
              report.probes.elicitationUrl,
            ].some((probe) => probe.status === "pending");
            if (taskAugmented && !hasInteractive) {
              options.runs.replaceProbe(runId, "legacyTaskInputRequired", {
                status: "not_exercised",
                detail: "No sampling or elicitation probe was available.",
              });
            }
            await runCapabilityProbes(
              {
                listRoots: (requestOptions) => server.server.listRoots(undefined, requestOptions),
                createMessage: (params, requestOptions) =>
                  server.server.createMessage(params, requestOptions),
                elicitInput: (params, requestOptions) =>
                  server.server.elicitInput(params, requestOptions),
              },
              options.runs,
              runId,
              timeouts,
              taskAugmented && hasInteractive
                ? {
                    taskId: task.taskId,
                    setInputRequired: () =>
                      extra.taskStore.updateTaskStatus(
                        task.taskId,
                        "input_required",
                        "Waiting for client interaction.",
                      ),
                    setWorking: async () => {
                      try {
                        await extra.taskStore.updateTaskStatus(task.taskId, "working");
                      } catch (error) {
                        if (!options.runs.signal(runId).aborted) throw error;
                      }
                    },
                  }
                : undefined,
            );
            const reportAfterScan = options.runs.report(runId);
            const nextActions = [
              ...(reportAfterScan.probes.legacyTaskCancel.status === "not_exercised"
                ? [`Invoke capabilities with {"action":"task_cancel","runId":"${runId}"} as a task-augmented call, cancel it, then call report.`]
                : []),
              ...(reportAfterScan.probes.mcpAppsRender.status === "pending"
                ? ["Open the MCP App view; it will submit app_report automatically."]
                : []),
            ];
            options.runs.setNextActions(runId, nextActions);
            await extra.taskStore.storeTaskResult(
              task.taskId,
              "completed",
              capabilityReportResult(options.runs.report(runId)),
            );
            return;
          }
          if (args.action === "app_report") {
            const app = args.app!;
            options.runs.replaceProbe(runId, "mcpAppsRender", {
              status: "passed",
              advertised: true,
              detail: "MCP App initialized in the host.",
            });
            options.runs.replaceProbe(runId, "mcpAppsTheme", app.theme === "provided"
              ? { status: "passed", advertised: true, detail: "Host supplied theme context." }
              : { status: "unsupported", advertised: true, detail: "Host supplied no theme context." });
            options.runs.replaceProbe(runId, "mcpAppsResize", app.resize === "observed"
              ? { status: "passed", advertised: true, detail: "Host container dimensions changed." }
              : app.resize === "fixed_container"
                ? { status: "supported_not_completed", advertised: true, detail: "Host declared a fixed container." }
                : { status: "failed", advertised: true, detail: "No resize outcome was observable.", errorCode: "resize_unobserved" });
            options.runs.replaceProbe(runId, "mcpAppsServerCall", {
              status: "passed",
              advertised: true,
              detail: "MCP App called the originating server tool.",
            });
            options.runs.setNextActions(runId, options.runs.report(runId).nextActions.filter(
              (action) => !action.startsWith("Open the MCP App"),
            ));
            await extra.taskStore.storeTaskResult(
              task.taskId,
              "completed",
              capabilityReportResult(options.runs.report(runId)),
            );
            return;
          }
          if (args.action === "report") {
            await extra.taskStore.storeTaskResult(
              task.taskId,
              "completed",
              capabilityReportResult(options.runs.report(runId)),
            );
            return;
          }
          if (!options.tasks.isTaskAugmented(task.taskId)) {
            options.runs.replaceProbe(runId, "legacyTaskCancel", {
              status: "not_exercised",
              detail: "task_cancel was called without task augmentation.",
            });
            await extra.taskStore.storeTaskResult(
              task.taskId,
              "completed",
              capabilityReportResult(options.runs.report(runId)),
            );
            return;
          }
          options.tasks.armCancellationTimeout(
            task.taskId,
            timeouts.cancellationTtlMs,
          );
        };

        void execute().catch(async (error: unknown) => {
          if (options.runs.signal(runId).aborted) return;
          const result = {
            content: [{
              type: "text" as const,
              text: error instanceof Error ? error.message : "Capability diagnostic failed.",
            }],
            isError: true,
          };
          try {
            await extra.taskStore.storeTaskResult(task.taskId, "failed", result);
          } catch (storeError) {
            if (!options.runs.signal(runId).aborted) {
              process.stderr.write(
                `Capability task result failed: ${storeError instanceof Error ? storeError.message : String(storeError)}\n`,
              );
            }
          }
        });
        return { task };
      },
      getTask: async (_args, extra) => {
        options.tasks.markPolled(extra.taskId);
        return extra.taskStore.getTask(extra.taskId);
      },
      getTaskResult: async (_args, extra) => {
        const dynamic = options.tasks.markResultRequested(extra.taskId);
        if (dynamic) return CallToolResultSchema.parse(dynamic);
        return CallToolResultSchema.parse(
          await extra.taskStore.getTaskResult(extra.taskId),
        );
      },
    },
  );
}
```

- [ ] **Step 6: Wire server capabilities and cleanup**

Update `src/server/index.ts` imports and options:

```ts
import { InMemoryTaskMessageQueue, InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type { TaskMessageQueue, TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import { CapabilityRunStore } from "./capabilityRuns.js";
import { CapabilityTaskStore } from "./capabilityTaskStore.js";
import { registerCapabilities } from "./capabilities.js";

export interface BuildServerOptions {
  paths?: OkhPaths;
  service?: ContainerService;
  taskStore?: TaskStore;
  taskMessageQueue?: TaskMessageQueue;
  capabilityRuns?: CapabilityRunStore;
  capabilityTimeouts?: Parameters<typeof registerCapabilities>[1]["timeouts"];
  capabilityRunId?: () => string;
}
```

Construct dependencies before `McpServer`:

```ts
const runs = options.capabilityRuns ?? new CapabilityRunStore();
const underlyingTaskStore = options.taskStore ?? new InMemoryTaskStore();
let observedTaskStore: CapabilityTaskStore;
observedTaskStore = new CapabilityTaskStore(
  underlyingTaskStore,
  runs,
  (runId) => capabilityReportResult(runs.report(runId)),
);
const taskMessageQueue = options.taskMessageQueue ?? new InMemoryTaskMessageQueue();
const server = new McpServer(
  { name: "open-knowledge-hub", version: "0.2.0" },
  {
    instructions: await buildInstructions(prefs as unknown as Record<string, unknown>),
    taskStore: observedTaskStore,
    taskMessageQueue,
    defaultTaskPollInterval: 500,
    maxTaskQueueSize: 64,
    capabilities: {
      tasks: {
        list: {},
        cancel: {},
        requests: { tools: { call: {} } },
      },
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    },
  },
);
```

After existing tools:

```ts
await registerTools(server, service, paths);
await registerCapabilities(server, {
  runs,
  tasks: observedTaskStore,
  ...(options.capabilityTimeouts ? { timeouts: options.capabilityTimeouts } : {}),
  ...(options.capabilityRunId ? { runId: options.capabilityRunId } : {}),
});
server.server.onclose = () => {
  observedTaskStore.cleanup();
  runs.dispose();
};
```

- [ ] **Step 7: Run schema, surface, and fallback tests**

Run:

```powershell
npx vitest run test/toolMeta.test.ts test/server.test.ts test/capabilities.test.ts
```

Expected: all targeted tests PASS; the exact tool count is 10; resources/tasks/Apps extension are advertised; no-capability scan completes.

- [ ] **Step 8: Commit registration and wiring**

```powershell
git add src\server\capabilities.ts src\server\toolSchemas.ts src\server\index.ts resources\tool-meta\capabilities.md resources\apps\capabilities.html test\server.test.ts test\capabilities.test.ts
git commit -m "feat: register capability diagnostic tool" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 7209fade-87bf-4294-81fb-0d4b01bd52f4"
```

### Task 7: Implement the self-contained MCP App

**Files:**
- Replace: `resources/apps/capabilities.html`
- Modify: `test/capabilities.test.ts`

- [ ] **Step 1: Add failing resource and callback tests**

Add:

```ts
it("lists and reads the packaged MCP App resource", async () => {
  const client = await connect({
    extensions: {
      "io.modelcontextprotocol/ui": {
        mimeTypes: ["text/html;profile=mcp-app"],
      },
    },
  });
  const resources = await client.listResources();
  expect(resources.resources).toContainEqual(expect.objectContaining({
    uri: "ui://open-knowledge-hub/capabilities",
    mimeType: "text/html;profile=mcp-app",
  }));
  const read = await client.readResource({ uri: "ui://open-knowledge-hub/capabilities" });
  const content = read.contents[0];
  expect(content).toMatchObject({
    uri: "ui://open-knowledge-hub/capabilities",
    mimeType: "text/html;profile=mcp-app",
  });
  expect("text" in content ? content.text : "").toContain("ui/initialize");
  expect("text" in content ? content.text : "").toContain("ui/notifications/size-changed");
  expect("text" in content ? content.text : "").toContain('"tools/call"');
  expect("text" in content ? content.text : "").not.toMatch(/https?:\/\/(?!example\.invalid)/);
});

it("accepts a schema-limited app_report and returns the refreshed report", async () => {
  const client = await connect({
    extensions: {
      "io.modelcontextprotocol/ui": {
        mimeTypes: ["text/html;profile=mcp-app"],
      },
    },
  });
  const scan = reportOf(await client.callTool({ name: "capabilities", arguments: {} }));
  expect(scan.probes.mcpAppsRender.status).toBe("pending");
  const refreshed = reportOf(await client.callTool({
    name: "capabilities",
    arguments: {
      action: "app_report",
      runId: scan.runId,
      app: { initialized: true, theme: "provided", resize: "observed" },
    },
  }));
  expect(refreshed.probes.mcpAppsRender.status).toBe("passed");
  expect(refreshed.probes.mcpAppsTheme.status).toBe("passed");
  expect(refreshed.probes.mcpAppsResize.status).toBe("passed");
  expect(refreshed.probes.mcpAppsServerCall.status).toBe("passed");
});

it("rejects arbitrary app callback fields", async () => {
  const client = await connect({
    extensions: {
      "io.modelcontextprotocol/ui": {
        mimeTypes: ["text/html;profile=mcp-app"],
      },
    },
  });
  const scan = reportOf(await client.callTool({ name: "capabilities", arguments: {} }));
  const result = await client.callTool({
    name: "capabilities",
    arguments: {
      action: "app_report",
      runId: scan.runId,
      app: {
        initialized: true,
        theme: "provided",
        resize: "observed",
        html: "<script>alert(1)</script>",
      },
    },
  });
  expect("isError" in result && result.isError).toBe(true);
});
```

- [ ] **Step 2: Run the tests and verify the bootstrap HTML fails**

Run:

```powershell
npx vitest run test/capabilities.test.ts
```

Expected: resource protocol-string assertions FAIL against the bootstrap HTML.

- [ ] **Step 3: Replace the App with a complete direct postMessage client**

Replace `resources/apps/capabilities.html` with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MCP Client Capabilities</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 12px; background: var(--color-background-primary, Canvas); color: var(--color-text-primary, CanvasText); }
    h1 { margin: 0 0 8px; font-size: 16px; }
    #status { margin-bottom: 8px; font-size: 13px; }
    pre { margin: 0; padding: 10px; overflow: auto; border: 1px solid var(--color-border-primary, GrayText); border-radius: 6px; white-space: pre-wrap; }
    #resize-probe { height: 1px; }
  </style>
</head>
<body>
  <h1>MCP Client Capabilities</h1>
  <div id="status">Connecting to host...</div>
  <pre id="report">Waiting for the tool result.</pre>
  <div id="resize-probe" aria-hidden="true"></div>
  <script>
    (() => {
      "use strict";
      const target = window.parent;
      const pending = new Map();
      const status = document.getElementById("status");
      const report = document.getElementById("report");
      const resizeProbe = document.getElementById("resize-probe");
      let nextId = 1;
      let hostContext = {};
      let initialized = false;
      let toolResult;
      let submitted = false;
      let resize = "unobserved";

      function post(message) {
        target.postMessage(message, "*");
      }

      function request(method, params, timeoutMs = 10000) {
        const id = nextId++;
        post({ jsonrpc: "2.0", id, method, params });
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(method + " timed out"));
          }, timeoutMs);
          pending.set(id, { resolve, reject, timer });
        });
      }

      function notify(method, params = {}) {
        post({ jsonrpc: "2.0", method, params });
      }

      function textOf(result) {
        if (!result || !Array.isArray(result.content)) return "";
        return result.content
          .filter((item) => item && item.type === "text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("\n");
      }

      function render(result) {
        const text = textOf(result);
        report.textContent = text || JSON.stringify(result && result.structuredContent || {}, null, 2);
      }

      function fixedContainer(context) {
        const dimensions = context && context.containerDimensions;
        return Boolean(
          dimensions &&
          (typeof dimensions.width === "number" || typeof dimensions.height === "number")
        );
      }

      async function submitAppReport() {
        if (!initialized || !toolResult || submitted) return;
        const structured = toolResult.structuredContent;
        const runId = structured && typeof structured.runId === "string"
          ? structured.runId
          : undefined;
        if (!runId) {
          status.textContent = "Rendered, but the tool result contained no run ID.";
          return;
        }
        submitted = true;
        status.textContent = "Submitting App observations...";
        try {
          const result = await request("tools/call", {
            name: "capabilities",
            arguments: {
              action: "app_report",
              runId,
              app: {
                initialized: true,
                theme: typeof hostContext.theme === "string" ? "provided" : "absent",
                resize,
              },
            },
          });
          render(result);
          status.textContent = "App probe complete.";
        } catch (error) {
          submitted = false;
          status.textContent = "App rendered, but app-to-server calling failed: " +
            (error instanceof Error ? error.message : String(error));
        }
      }

      window.addEventListener("message", (event) => {
        if (event.source !== target) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error) {
            waiter.reject(new Error(message.error.message || "JSON-RPC error"));
          } else {
            waiter.resolve(message.result);
          }
          return;
        }
        if (message.method === "ui/notifications/tool-result") {
          toolResult = message.params;
          render(toolResult);
          void submitAppReport();
        }
        if (message.method === "ui/notifications/host-context-changed") {
          hostContext = Object.assign({}, hostContext, message.params || {});
        }
      });

      async function main() {
        const before = { width: window.innerWidth, height: window.innerHeight };
        const init = await request("ui/initialize", {
          appInfo: { name: "open-knowledge-hub-capabilities", version: "1.0.0" },
          appCapabilities: {},
          protocolVersion: "2026-01-26",
        });
        hostContext = init && init.hostContext || {};
        notify("ui/notifications/initialized");
        initialized = true;
        status.textContent = "App initialized; testing resize...";
        resizeProbe.style.height = "320px";
        notify("ui/notifications/size-changed", {
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        resize = fixedContainer(hostContext)
          ? "fixed_container"
          : (window.innerWidth !== before.width || window.innerHeight !== before.height)
            ? "observed"
            : "unobserved";
        await submitAppReport();
      }

      void main().catch((error) => {
        status.textContent = "MCP App initialization failed: " +
          (error instanceof Error ? error.message : String(error));
      });
    })();
  </script>
</body>
</html>
```

This file has no external script/style/font/network dependency and validates `event.source === window.parent`.

- [ ] **Step 4: Run App/resource tests**

Run:

```powershell
npx vitest run test/capabilities.test.ts test/server.test.ts
```

Expected: App resource, callback, schema rejection, and server-surface tests PASS.

- [ ] **Step 5: Commit the MCP App**

```powershell
git add resources\apps\capabilities.html test\capabilities.test.ts
git commit -m "feat: add MCP Apps capability probe" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 7209fade-87bf-4294-81fb-0d4b01bd52f4"
```

### Task 8: Add full in-memory protocol integration coverage

**Files:**
- Modify: `test/capabilities.test.ts`
- Modify: `src/server/capabilities.ts`
- Modify: `src/server/capabilityProbes.ts`

- [ ] **Step 1: Add a configurable client helper**

Extend the integration helper to install handlers before connection:

```ts
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  type ClientCapabilities,
  type CreateMessageRequest,
  type ElicitRequest,
} from "@modelcontextprotocol/sdk/types.js";

interface ClientHandlers {
  roots?: () => { roots: { uri: string; name?: string }[] };
  sampling?: (request: CreateMessageRequest) => Promise<{
    role: "assistant";
    model: string;
    content: { type: "text"; text: string } | {
      type: "tool_use";
      name: string;
      id: string;
      input: Record<string, unknown>;
    }[];
    stopReason?: string;
  }>;
  elicitation?: (request: ElicitRequest) => Promise<{
    action: "accept" | "decline" | "cancel";
    content?: Record<string, string | number | boolean | string[]>;
  }>;
}

async function connect(
  capabilities: ClientCapabilities = {},
  handlers: ClientHandlers = {},
) {
  const home = await makeTempDir();
  homes.push(home);
  const paths = makePaths(home);
  const service = new ContainerService(
    paths,
    new Git(testRun),
    new FakeGh() as unknown as Gh,
  );
  const server = await buildServer({
    paths,
    service,
    capabilityTimeouts: {
      machineMs: 100,
      samplingMs: 100,
      elicitationMs: 100,
      cancellationTtlMs: 100,
      taskPollIntervalMs: 5,
    },
    capabilityRunId: () => "0123456789abcdef0123456789abcdef",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "capability-test-client", version: "1" },
    { capabilities },
  );
  if (handlers.roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => handlers.roots!());
  }
  if (handlers.sampling) {
    client.setRequestHandler(CreateMessageRequestSchema, handlers.sampling);
  }
  if (handlers.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, handlers.elicitation);
  }
  servers.push(server);
  clients.push(client);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}
```

Use different deterministic run IDs per test when a test creates more than one run.

- [ ] **Step 2: Add roots/sampling/form/URL success integration**

Add one client advertising every 2025 capability. The sampling handler returns a tool-use block when `request.params.tools` is present and text otherwise; the elicitation handler accepts both modes. Assert:

```ts
expect(report.probes.roots.status).toBe("passed");
expect(report.probes.rootsListChanged.status).toBe("advertised_only");
expect(report.probes.samplingBasic.status).toBe("passed");
expect(report.probes.samplingTools.status).toBe("passed");
expect(report.probes.elicitationForm.status).toBe("passed");
expect(report.probes.elicitationUrl.status).toBe("passed");
expect(report.advertised.tasks).toEqual({
  list: true,
  cancel: true,
  samplingCreateMessage: true,
  elicitationCreate: true,
});
```

The handler must record requests and assert:

```ts
expect(samplingRequests.every((request) => request.params.includeContext === "none")).toBe(true);
expect(urlRequest.params).toMatchObject({
  mode: "url",
  elicitationId: "capabilities-0123456789abcdef0123456789abcdef",
});
```

- [ ] **Step 3: Add decline/error/malformed integration cases**

Add separate tests for:

1. Sampling handler throws `new McpError(ErrorCode.InvalidRequest, "user rejected request")` -> `supported_not_completed`.
2. Form and URL return `decline`/`cancel` -> `supported_not_completed`.
3. Roots returns a malformed HTTPS URI through a justified boundary cast -> `failed`, `invalid_root_uri`.
4. Sampling-tools returns duplicate IDs -> `failed`, `invalid_tool_use`.
5. Advertised Apps extension with `mimeTypes: ["text/html"]` -> all App probes `unsupported`, fixed MIME mismatch detail.

For every case, assert raw root paths, generated text, model names, elicited values, and tool input values are absent from both text and `structuredContent`:

```ts
const serialized = JSON.stringify(result);
expect(serialized).not.toContain("file:///private/secret");
expect(serialized).not.toContain("generated-secret");
expect(serialized).not.toContain("private-model");
expect(serialized).not.toContain("tool-input-secret");
```

- [ ] **Step 4: Add task-augmented create/poll/input/result test**

Use:

```ts
const messages = [];
for await (const message of client.experimental.tasks.callToolStream(
  { name: "capabilities", arguments: {} },
  undefined,
  { task: { ttl: 1_000, pollInterval: 5 } },
)) {
  messages.push(message);
}
const created = messages.find((message) => message.type === "taskCreated");
const statuses = messages
  .filter((message) => message.type === "taskStatus")
  .map((message) => message.task.status);
const final = messages.find((message) => message.type === "result");
expect(created).toBeDefined();
expect(statuses).toContain("input_required");
expect(final).toBeDefined();
const report = reportOf(final!.result);
expect(report.probes.legacyTaskCreate.status).toBe("passed");
expect(report.probes.legacyTaskPoll.status).toBe("passed");
expect(report.probes.legacyTaskInputRequired.status).toBe("passed");
expect(report.probes.legacyTaskResult.status).toBe("passed");
```

The client must advertise task-hosted sampling/elicitation capabilities, but the assertions must explain that server-tool task support is proven by task augmentation, not by `ClientCapabilities.tasks`.

- [ ] **Step 5: Add cancellation and refreshed-report test**

First obtain a run ID from a task-augmented scan. Then:

```ts
const stream = client.experimental.tasks.callToolStream(
  {
    name: "capabilities",
    arguments: { action: "task_cancel", runId },
  },
  undefined,
  { task: { ttl: 1_000, pollInterval: 5 } },
);
const iterator = stream[Symbol.asyncIterator]();
const first = await iterator.next();
expect(first.value?.type).toBe("taskCreated");
if (first.value?.type !== "taskCreated") throw new Error("Expected taskCreated.");
await client.experimental.tasks.cancelTask(first.value.task.taskId);
const refreshed = reportOf(await client.callTool({
  name: "capabilities",
  arguments: { action: "report", runId },
}));
expect(refreshed.probes.legacyTaskCancel.status).toBe("passed");
```

Also call `task_cancel` normally and assert `legacyTaskCancel` remains `not_exercised`.

- [ ] **Step 6: Add unknown/expired/cross-client action tests**

Inject a `CapabilityRunStore` with a fake clock:

```ts
let now = 0;
const runs = new CapabilityRunStore({ now: () => now, ttlMs: 10, maxRuns: 2 });
```

Assert:

- `report` with an unknown run returns an MCP tool error.
- advancing `now` beyond 10 makes `report` return an expired-run tool error.
- `report` without `runId`, `scan` with `runId`, and `app_report` without `app`
  return invalid-params tool errors.
- run-store unit tests cover cross-client binding with distinct keys because one `McpServer` connection owns one initialized client.

- [ ] **Step 7: Run all capability tests**

Run:

```powershell
npx vitest run test/capabilityReport.test.ts test/capabilityRuns.test.ts test/capabilityProbes.test.ts test/capabilityTaskStore.test.ts test/capabilities.test.ts test/server.test.ts test/toolMeta.test.ts
```

Expected: all targeted tests PASS.

- [ ] **Step 8: Commit integration coverage and any fixes**

```powershell
git add src\server\capabilities.ts src\server\capabilityProbes.ts test\capabilities.test.ts
git commit -m "test: cover MCP client capability probes" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 7209fade-87bf-4294-81fb-0d4b01bd52f4"
```

### Task 9: Document the surface and add the terminal eval

**Files:**
- Modify: `README.md:52-89`
- Modify: `DEVELOPMENT.md:12-70`
- Modify: `eval/README.md:1-60`
- Create: `eval/scenarios/capabilities/terminal-fallback.yaml`

- [ ] **Step 1: Update README MCP surface**

Add `capabilities` to the operational table:

```markdown
| `capabilities` | `action?`, `runId?`, `app?` | Test client roots, sampling, elicitation, MCP Apps, and legacy Tasks; returns App-enhanced or terminal output. |
```

Replace `**Resources:** none.` with:

```markdown
**Resources:** one self-contained MCP App at
`ui://open-knowledge-hub/capabilities`. MCP Apps-capable hosts render the
interactive report; terminal clients receive the same report as text and
`structuredContent`.
```

Add a typical usage line:

```markdown
- `capabilities` -> run a privacy-safe client capability diagnostic. Follow the returned `task_cancel`/`report` actions to complete legacy task cancellation testing.
```

- [ ] **Step 2: Add development/manual testing guidance**

Add a `## Test client capabilities` section to `DEVELOPMENT.md`:

```markdown
## Test client capabilities

Build and restart the MCP server, then call `capabilities` with no arguments.

- In a terminal client, verify the text table reports unsupported and
  `not_exercised` states explicitly. If the client supports task-augmented tool
  calls, follow the returned `task_cancel` action and then call `report`.
- In an MCP Apps-capable GUI host, verify the App renders, reflects host theme,
  changes its requested size, calls back to the same server, and refreshes the
  normalized report.
- The diagnostic must never print root paths, generated sampling text, elicited
  values, or sampling tool inputs.

Use `npm run inspect` for resource/tool metadata checks. Inspector does not
replace validation in an actual MCP Apps host.
```

Change `## Eval (live, optional)` to `## Eval (live)` because the approved completion gate requires the full live eval for this larger change.

- [ ] **Step 3: Add the Copilot CLI fallback scenario**

Create `eval/scenarios/capabilities/terminal-fallback.yaml`:

```yaml
- config:
    - vars:
        env: empty
        prompt: |
          Use the open-knowledge-hub MCP capabilities tool to test this MCP client.
          Summarize the normalized result in a terminal-friendly table. Do not assume
          a graphical MCP App is available.
  tests:
    - description: Capabilities - terminal fallback - reports explicit support states
      assert:
        - type: javascript
          value: file://assertions/tools-called.ts
          config: { expect: [capabilities] }
        - type: javascript
          value: file://assertions/transcript.ts
          config:
            mustContain:
              - roots
              - sampling
              - elicitation
              - MCP Apps|mcpApps
              - Tasks|legacyTask
              - unsupported|not_exercised|passed|failed
```

Do not add a judge assertion; this scenario has deterministic tool-call and transcript-shape requirements.

- [ ] **Step 4: Update eval documentation**

In `eval/README.md`:

- replace the stale fixed scenario count with "the scenario suite"
- add `capabilities/terminal-fallback.yaml` to the scenario examples
- note that this scenario intentionally validates the text fallback because Copilot CLI does not render the App resource

- [ ] **Step 5: Validate docs/eval structure**

Run:

```powershell
npm run typecheck:eval
npm run test:eval
npm run eval:validate
```

Expected:

- eval TypeScript exits 0
- eval unit tests PASS
- promptfoo prints `Configuration is valid.`

- [ ] **Step 6: Commit docs and eval**

```powershell
git add README.md DEVELOPMENT.md eval\README.md eval\scenarios\capabilities\terminal-fallback.yaml
git commit -m "docs: add capability diagnostic workflow" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 7209fade-87bf-4294-81fb-0d4b01bd52f4"
```

### Task 10: Run completion validation and review the final diff

**Files:**
- Modify only files required by failures directly caused by this feature.

- [ ] **Step 1: Build before any live eval**

Run:

```powershell
npm run build
```

Expected: TypeScript build exits 0 and updates `dist/` locally. Do not commit `dist/` unless the repository already tracks it.

- [ ] **Step 2: Run typecheck and core tests**

Run:

```powershell
npm run typecheck
npm test
```

Expected: typecheck exits 0 and all core Vitest tests PASS.

- [ ] **Step 3: Run eval checks**

Run:

```powershell
npm run typecheck:eval
npm run test:eval
npm run eval:validate
```

Expected: all commands exit 0; promptfoo configuration is valid.

- [ ] **Step 4: Run the full live e2e eval**

Run:

```powershell
npm run eval
```

Expected: the complete promptfoo/Copilot CLI suite passes, including `Capabilities - terminal fallback - reports explicit support states`.

If the new scenario fails, inspect the latest `promptfoo.db` failure record and fix only the diagnostic/eval behavior responsible. Rebuild before rerunning because the harness launches `dist/index.js`.

- [ ] **Step 5: Manually validate the terminal fallback**

Build and point a terminal MCP client at `dist/index.js`. Call `capabilities` with
no arguments and confirm the text table matches `structuredContent`, unsupported
and `not_exercised` states are explicit, and no sensitive payload appears. If
the client supports task augmentation, run the returned `task_cancel` action,
cancel the created task, then call `report` and confirm
`legacyTaskCancel: passed`.

- [ ] **Step 6: Manually validate an MCP Apps host**

In at least one MCP Apps-capable GUI host, call `capabilities` and confirm:

- the `ui://open-knowledge-hub/capabilities` resource renders
- host theme/context is reflected in the refreshed report
- the App sends a size-change notification and reports observed/fixed/unobserved
- the App calls `capabilities app_report` through the host
- the refreshed report is equivalent to the terminal report

If no MCP Apps host is available, mark implementation completion blocked rather
than claiming the App UX was validated.

- [ ] **Step 7: Inspect the final change set**

Run:

```powershell
git --no-pager status --short
git --no-pager diff --check
git --no-pager diff --stat HEAD~5..HEAD
git --no-pager diff HEAD~5..HEAD -- src resources test eval README.md DEVELOPMENT.md
```

Confirm:

- exactly 10 tools are exposed
- the App resource has the correct MIME type and both tool metadata keys
- no new runtime dependency was added
- no report/state field can contain root paths, generated text, elicited values, or arbitrary app payloads
- normal calls return terminal text without requiring Tasks or Apps
- task-augmented calls prove create/poll/input/result, and follow-up cancellation proves cancel
- modern MRTR and `io.modelcontextprotocol/tasks` remain explicitly `not_exercised`

- [ ] **Step 8: Commit any validation-only fixes**

If validation required source/test/doc changes:

```powershell
git add src resources test eval README.md DEVELOPMENT.md
git commit -m "fix: complete capability diagnostic validation" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 7209fade-87bf-4294-81fb-0d4b01bd52f4"
```

If no changes were required, do not create an empty commit.
