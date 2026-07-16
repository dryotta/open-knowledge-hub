import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../test/helpers.js";
import judge from "../eval/assertions/judge.js";
import type { Criterion, CriterionResult, JudgeTelemetry } from "../eval/judge.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Build an injectable deps object whose runJudgeCriteria returns canned verdicts. */
function fakeJudge(results: Array<Partial<CriterionResult> & { id: string; verdict: CriterionResult["verdict"] }>) {
  const full: CriterionResult[] = results.map((r) => ({
    id: r.id,
    verdict: r.verdict,
    passVotes: r.passVotes ?? (r.verdict === "PASS" ? 3 : 0),
    failVotes: r.failVotes ?? (r.verdict === "FAIL" ? 3 : 0),
    validVotes: r.validVotes ?? 3,
    invalidVotes: r.invalidVotes ?? 0,
    configuredVotes: r.configuredVotes ?? 3,
    skippedVotes: r.skippedVotes ?? 0,
    invalidReasons: r.invalidReasons ?? [],
    evidence: [],
  }));
  return { runJudgeCriteria: async () => full };
}

async function okhHomeWith(name: string, module?: string): Promise<string> {
  const home = await makeTempDir(); cleanups.push(home);
  const c = join(home, "containers", name);
  await mkdir(c, { recursive: true });
  if (module) {
    await mkdir(join(c, module, ".okh"), { recursive: true });
    await writeFile(join(c, module, ".okh", "module.yaml"), `type: knowledge\nname: ${module}\ndescription: Test\n`, "utf8");
  }
  await writeFile(join(home, "registry.json"), JSON.stringify({ version: 1, containers: [{ name, backend: "local", localPath: c, sync: "auto", addedAt: new Date().toISOString() }] }), "utf8");
  return home;
}

describe("judge assertion", () => {
  it("passes when all required criteria PASS and cross-checks agree", async () => {
    const okhHome = await okhHomeWith("my-notes", "kb");
    const r = await judge(
      "transcript",
      {
        config: { criteria: [
          { id: "previewed", text: "previewed" },
          { id: "created", text: "created", check: { kind: "container", name: "my-notes", module: "kb" } },
        ] },
        providerResponse: { metadata: { okhHome, toolCalls: ["add"] } },
      },
      fakeJudge([{ id: "previewed", verdict: "PASS" }, { id: "created", verdict: "PASS" }]),
    );
    expect(r.pass).toBe(true);
  });

  it("required checked criterion: det=FAIL overrides judge=PASS", async () => {
    const okhHome = await okhHomeWith("other"); // "my-notes" NOT registered → det=FAIL
    const r = await judge(
      "t",
      {
        config: { criteria: [{ id: "created", text: "created", check: { kind: "container", name: "my-notes" } }] },
        providerResponse: { metadata: { okhHome, toolCalls: [] } },
      },
      fakeJudge([{ id: "created", verdict: "PASS" }]),
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/det=FAIL.*judge=PASS/);
  });

  it("required checked criterion: det=PASS wins over judge=UNRELIABLE", async () => {
    const okhHome = await okhHomeWith("my-notes"); // "my-notes" IS registered → det=PASS
    const r = await judge(
      "t",
      {
        config: { criteria: [{ id: "created", text: "created", check: { kind: "container", name: "my-notes" } }] },
        providerResponse: { metadata: { okhHome, toolCalls: [] } },
      },
      fakeJudge([{ id: "created", verdict: "UNRELIABLE", passVotes: 1, failVotes: 0, validVotes: 1 }]),
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/det=PASS.*judge=UNRELIABLE/);
  });

  it("required checked criterion: det=PASS wins over judge=FAIL", async () => {
    const okhHome = await okhHomeWith("my-notes"); // "my-notes" IS registered → det=PASS
    const r = await judge(
      "t",
      {
        config: { criteria: [{ id: "created", text: "created", check: { kind: "container", name: "my-notes" } }] },
        providerResponse: { metadata: { okhHome, toolCalls: [] } },
      },
      fakeJudge([{ id: "created", verdict: "FAIL" }]),
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/det=PASS.*judge=FAIL/);
  });

  it("required checked criterion: det=PASS wins even when judge result is absent (MISSING)", async () => {
    const okhHome = await okhHomeWith("my-notes"); // "my-notes" IS registered → det=PASS
    const r = await judge(
      "t",
      {
        config: { criteria: [{ id: "created", text: "created", check: { kind: "container", name: "my-notes" } }] },
        providerResponse: { metadata: { okhHome, toolCalls: [] } },
      },
      fakeJudge([]), // judge omits "created"
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/det=PASS.*judge=MISSING/);
  });
  it("uses structured todo-apply-sync evidence when the rendered transcript judge disagrees", async () => {
    const r = await judge(
      "truncated rendered transcript",
      {
        config: {
          criteria: [{
            id: "workflow",
            text: "applies todo with apply:true and syncs immediately",
            check: { kind: "todo-apply-sync", operation: "update" },
          }],
        },
        providerResponse: {
          metadata: {
            toolEvents: [
              { turn: 1, callId: "t2", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true, apply: true }, completed: true, success: true },
              { turn: 1, callId: "t3", server: "open-knowledge-hub", tool: "sync", arguments: { container: "kb-hub" }, completed: true, success: true },
            ],
          },
        },
      },
      fakeJudge([{ id: "workflow", verdict: "FAIL" }]),
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/det=PASS/);
  });

  it("fails when a required criterion is UNRELIABLE", async () => {
    const r = await judge(
      "t",
      { config: { criteria: [{ id: "x", text: "x" }] }, providerResponse: { metadata: {} } },
      fakeJudge([{ id: "x", verdict: "UNRELIABLE", passVotes: 1, failVotes: 0, validVotes: 1 }]),
    );
    expect(r.pass).toBe(false);
  });

  it("fails when a required criterion is missing from judge results", async () => {
    const r = await judge(
      "t",
      { config: { criteria: [{ id: "present", text: "p" }, { id: "missing", text: "m" }] }, providerResponse: { metadata: {} } },
      fakeJudge([{ id: "present", verdict: "PASS" }]),
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/missing: MISSING/);
  });

  it("advisory (required:false) criterion does not gate", async () => {
    const r = await judge(
      "t",
      {
        config: { criteria: [{ id: "must", text: "m" }, { id: "nice", text: "n", required: false }] },
        providerResponse: { metadata: {} },
      },
      fakeJudge([{ id: "must", verdict: "PASS" }, { id: "nice", verdict: "FAIL" }]),
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/advisory/);
  });

  it("advisory checked criterion never gates overall pass", async () => {
    const okhHome = await okhHomeWith("other"); // "my-notes" NOT registered → det=FAIL
    const r = await judge(
      "t",
      {
        config: { criteria: [{ id: "created", text: "created", required: false, check: { kind: "container", name: "my-notes" } }] },
        providerResponse: { metadata: { okhHome, toolCalls: [] } },
      },
      fakeJudge([{ id: "created", verdict: "PASS" }]),
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/det=FAIL.*judge=PASS/);
    expect(r.reason).toMatch(/advisory/);
  });

  it("annotates a borderline (split-vote) pass", async () => {
    const r = await judge(
      "t",
      { config: { criteria: [{ id: "x", text: "x" }] }, providerResponse: { metadata: {} } },
      fakeJudge([{ id: "x", verdict: "PASS", passVotes: 2, failVotes: 1, validVotes: 3 }]),
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/borderline/);
  });

  it("forwards k and graderModel config to runJudgeCriteria", async () => {
    let recordedOpts: { k?: number; model?: string; onTelemetry?: (telemetry: JudgeTelemetry) => void } | undefined;
    const metadata: {
      timings?: Record<string, unknown> & { judgeMs?: number };
      judge?: JudgeTelemetry;
    } = {};
    const r = await judge(
      "t",
      {
        config: { k: 5, graderModel: "m", criteria: [{ id: "x", text: "x" }] },
        providerResponse: { metadata },
      },
      {
        runJudgeCriteria: async (
          _criteria: Criterion[],
          _transcript: string,
          opts: { k?: number; model?: string; onTelemetry?: (telemetry: JudgeTelemetry) => void } = {},
        ): Promise<CriterionResult[]> => {
          recordedOpts = opts;
          opts.onTelemetry?.({
            configuredRuns: 5,
            launchedRuns: 3,
            completedRuns: 3,
            skippedRuns: 2,
            invalidRuns: 0,
            durationMs: 12,
          });
          return [{
            id: "x",
            verdict: "PASS",
            passVotes: 3,
            failVotes: 0,
            validVotes: 3,
            invalidVotes: 0,
            configuredVotes: 3,
            skippedVotes: 0,
            invalidReasons: [],
            evidence: [],
          }];
        },
      },
    );
    expect(r.pass).toBe(true);
    expect(recordedOpts).toMatchObject({ k: 5, model: "m" });
    expect((recordedOpts as { abortSignal?: AbortSignal }).abortSignal).toBeInstanceOf(AbortSignal);
    expect(metadata).toMatchObject({
      timings: { judgeMs: 12 },
      judge: { launchedRuns: 3, configuredRuns: 5, skippedRuns: 2 },
    });
  });

  it("fails fast when no criteria are provided", async () => {
    const r = await judge("t", { config: {}, providerResponse: { metadata: {} } });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/no criteria/);
  });
});
