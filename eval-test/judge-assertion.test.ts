import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../test/helpers.js";
import judge from "../eval/assertions/judge.js";
import type { Criterion, CriterionResult } from "../eval/judge.js";

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
    evidence: [],
  }));
  return { runJudgeCriteria: async () => full };
}

async function okhHomeWith(name: string, module?: string): Promise<string> {
  const home = await makeTempDir(); cleanups.push(home);
  const c = join(home, "containers", name);
  await mkdir(join(c, ".okh"), { recursive: true });
  const mods = module ? `modules:\n  - path: ${module}\n    type: knowledge\n` : "modules: []\n";
  await writeFile(join(c, ".okh", "okh.yaml"), `name: ${name}\nsync: auto\n${mods}`, "utf8");
  await writeFile(join(home, "registry.json"), JSON.stringify({ version: 1, containers: [{ name, backend: "local", localPath: c, addedAt: new Date().toISOString() }] }), "utf8");
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

  it("fails and flags a judge/deterministic disagreement", async () => {
    const okhHome = await okhHomeWith("other"); // "my-notes" NOT registered
    const r = await judge(
      "t",
      {
        config: { criteria: [{ id: "created", text: "created", check: { kind: "container", name: "my-notes" } }] },
        providerResponse: { metadata: { okhHome, toolCalls: [] } },
      },
      fakeJudge([{ id: "created", verdict: "PASS" }]),
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/DISAGREE/);
  });

  it("fails when a checked required criterion is UNRELIABLE even if deterministic check passes", async () => {
    const okhHome = await okhHomeWith("my-notes");
    let checkReads = 0;
    const check = new Proxy({ kind: "container" as const, name: "my-notes" }, {
      get(target, prop, receiver) {
        if (prop === "kind" || prop === "name") checkReads++;
        return Reflect.get(target, prop, receiver);
      },
    });
    const r = await judge(
      "t",
      {
        config: { criteria: [{ id: "created", text: "created", check }] },
        providerResponse: { metadata: { okhHome, toolCalls: [] } },
      },
      fakeJudge([{ id: "created", verdict: "UNRELIABLE", passVotes: 1, failVotes: 0, validVotes: 1 }]),
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/unreliable/);
    expect(checkReads).toBe(0);
  });

  it("fails and flags a reverse judge/deterministic disagreement", async () => {
    const okhHome = await okhHomeWith("my-notes");
    const r = await judge(
      "t",
      {
        config: { criteria: [{ id: "created", text: "created", check: { kind: "container", name: "my-notes" } }] },
        providerResponse: { metadata: { okhHome, toolCalls: [] } },
      },
      fakeJudge([{ id: "created", verdict: "FAIL" }]),
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/DISAGREE/);
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

  it("advisory checked criterion gates on judge/deterministic disagreement", async () => {
    const okhHome = await okhHomeWith("other"); // "my-notes" NOT registered
    const r = await judge(
      "t",
      {
        config: { criteria: [{ id: "created", text: "created", required: false, check: { kind: "container", name: "my-notes" } }] },
        providerResponse: { metadata: { okhHome, toolCalls: [] } },
      },
      fakeJudge([{ id: "created", verdict: "PASS" }]),
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/DISAGREE/);
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
    let recordedOpts: { k?: number; model?: string } | undefined;
    const r = await judge(
      "t",
      {
        config: { k: 5, graderModel: "m", criteria: [{ id: "x", text: "x" }] },
        providerResponse: { metadata: {} },
      },
      {
        runJudgeCriteria: async (
          _criteria: Criterion[],
          _transcript: string,
          opts: { k?: number; model?: string } = {},
        ): Promise<CriterionResult[]> => {
          recordedOpts = opts;
          return [{ id: "x", verdict: "PASS", passVotes: 3, failVotes: 0, validVotes: 3, evidence: [] }];
        },
      },
    );
    expect(r.pass).toBe(true);
    expect(recordedOpts).toEqual({ k: 5, model: "m" });
  });

  it("fails fast when no criteria are provided", async () => {
    const r = await judge("t", { config: {}, providerResponse: { metadata: {} } });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/no criteria/);
  });
});
