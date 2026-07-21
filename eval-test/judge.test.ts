import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { makeTempDir } from "../test/helpers.js";
import { extractJson, extractJsonArray, runJudgeCriteria, type JudgeTelemetry } from "../eval/judge.js";
import { buildArtifactsSection } from "../eval/assertions/judge.js";
import type { CopilotRunner } from "../eval/copilot.js";

describe("extractJson", () => {
  it("extracts the last balanced JSON object amid prose/reasoning", () => {
    const o = extractJson('reasoning {"a":1} then final {"pass":true,"score":0.9,"reason":"ok"}');
    expect(o).toEqual({ pass: true, score: 0.9, reason: "ok" });
  });
  it("handles braces inside strings", () => {
    const o = extractJson('{"pass":false,"score":0.2,"reason":"had a { brace"}');
    expect(o).toEqual({ pass: false, score: 0.2, reason: "had a { brace" });
  });
  it("returns null when no JSON object is present", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});

describe("extractJsonArray", () => {
  it("extracts the last balanced JSON array amid prose/fences", () => {
    const a = extractJsonArray('thinking [1] then [{"id":"x","verdict":"PASS"}]');
    expect(a).toEqual([{ id: "x", verdict: "PASS" }]);
  });
  it("handles brackets inside strings", () => {
    const a = extractJsonArray('[{"id":"a","evidence":"has ] bracket","verdict":"FAIL"}]');
    expect(a).toEqual([{ id: "a", evidence: "has ] bracket", verdict: "FAIL" }]);
  });
  it("returns null when no JSON array is present", () => {
    expect(extractJsonArray("no array here {\"id\":1}")).toBeNull();
  });
});

function withTestEvidence(output: string): string {
  const parsed = extractJsonArray(output);
  if (!parsed) return output;
  return JSON.stringify(parsed.map((item) => (
    item && typeof item === "object" && !Array.isArray(item)
      ? { evidence: "test evidence", ...(item as Record<string, unknown>) }
      : item
  )));
}

function seqRunner(outputs: string[]): CopilotRunner {
  let i = 0;
  return async () => ({
    transcript: withTestEvidence(outputs[Math.min(i++, outputs.length - 1)]!),
    code: 0,
  });
}

const CRITERIA = [
  { id: "a", text: "criterion a" },
  { id: "b", text: "criterion b" },
];
const PASS_A = '[{"id":"a","verdict":"PASS","evidence":"test evidence"}]';

describe("runJudgeCriteria", () => {
  it("rejects duplicate criterion ids before launching judges", async () => {
    let calls = 0;
    await expect(
      runJudgeCriteria(
        [{ id: "a", text: "first" }, { id: "a", text: "second" }],
        "t",
        { runner: async () => { calls++; return { transcript: PASS_A, code: 0 }; } },
      ),
    ).rejects.toThrow(/unique/i);
    expect(calls).toBe(0);
  });

  it("forwards cancellation and scopes judge roots to the eval run", async () => {
    const previousRunId = process.env.OKH_EVAL_RUN_ID;
    process.env.OKH_EVAL_RUN_ID = "run-123";
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    let rootName = "";
    try {
      const runner: CopilotRunner = async (opts) => {
        signal = opts.abortSignal;
        rootName = basename(dirname(opts.cwd));
        return { transcript: PASS_A, code: 0 };
      };
      await runJudgeCriteria([{ id: "a", text: "a" }], "t", {
        k: 1,
        runner,
        abortSignal: controller.signal,
      });
      expect(signal).toBe(controller.signal);
      expect(rootName).toMatch(/^okh-eval-run-123-judge-/);
    } finally {
      if (previousRunId === undefined) delete process.env.OKH_EVAL_RUN_ID;
      else process.env.OKH_EVAL_RUN_ID = previousRunId;
    }
  });

  it("uses GPT-5.6 Luna as the default judge model", async () => {
    const prev = process.env.OKH_JUDGE_MODEL;
    delete process.env.OKH_JUDGE_MODEL;
    try {
      let model: string | undefined;
      const runner: CopilotRunner = async (opts) => {
        model = opts.model;
        return { transcript: PASS_A, code: 0 };
      };

      await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 1, runner });

      expect(model).toBe("gpt-5.6-luna");
    } finally {
      if (prev === undefined) delete process.env.OKH_JUDGE_MODEL;
      else process.env.OKH_JUDGE_MODEL = prev;
    }
  });

  it("moves an oversized grading prompt from argv to isolated custom instructions", async () => {
    const transcript = "grounded evidence\n".repeat(2_000);
    let inlinePrompt = "";
    let instructionPrompt = "";
    const runner: CopilotRunner = async (opts) => {
      inlinePrompt = opts.prompt;
      expect(opts.loadCustomInstructions).toBe(true);
      instructionPrompt = await readFile(join(opts.cwd, "AGENTS.md"), "utf8");
      return { transcript: PASS_A, code: 0 };
    };

    await runJudgeCriteria([{ id: "a", text: "a" }], transcript, { k: 1, runner });

    expect(inlinePrompt.length).toBeLessThan(1_000);
    expect(instructionPrompt).toContain(transcript);
    expect(instructionPrompt).toContain("Respond with ONLY a JSON array");
  });

  it("uses OKH_JUDGE_MODEL unless an explicit model is provided", async () => {
    const prev = process.env.OKH_JUDGE_MODEL;
    process.env.OKH_JUDGE_MODEL = "claude-haiku-4.5";
    try {
      const models: Array<string | undefined> = [];
      const runner: CopilotRunner = async (opts) => {
        models.push(opts.model);
        return { transcript: PASS_A, code: 0 };
      };

      await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 1, runner });
      await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 1, model: "claude-sonnet-4.5", runner });

      expect(models).toEqual(["claude-haiku-4.5", "claude-sonnet-4.5"]);
    } finally {
      if (prev === undefined) delete process.env.OKH_JUDGE_MODEL;
      else process.env.OKH_JUDGE_MODEL = prev;
    }
  });

  it("caps default parallel judge votes at two", async () => {
    const prev = process.env.OKH_JUDGE_CONCURRENCY;
    delete process.env.OKH_JUDGE_CONCURRENCY;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maxActive = 0;
    const runner: CopilotRunner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      return { transcript: PASS_A, code: 0 };
    };
    try {
      const pending = runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 3, runner });
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      await pending;

      expect(maxActive).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.OKH_JUDGE_CONCURRENCY;
      else process.env.OKH_JUDGE_CONCURRENCY = prev;
    }
  });

  it("caps parallel judge votes with OKH_JUDGE_CONCURRENCY", async () => {
    const prev = process.env.OKH_JUDGE_CONCURRENCY;
    process.env.OKH_JUDGE_CONCURRENCY = "2";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maxActive = 0;
    const runner: CopilotRunner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      return { transcript: PASS_A, code: 0 };
    };
    try {
      const pending = runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 3, runner });
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      await pending;

      expect(maxActive).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.OKH_JUDGE_CONCURRENCY;
      else process.env.OKH_JUDGE_CONCURRENCY = prev;
    }
  });

  it("falls back to k when OKH_JUDGE_CONCURRENCY is fractional", async () => {
    const prev = process.env.OKH_JUDGE_CONCURRENCY;
    process.env.OKH_JUDGE_CONCURRENCY = "1.5";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maxActive = 0;
    const runner: CopilotRunner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      return { transcript: PASS_A, code: 0 };
    };
    try {
      const pending = runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 3, runner });
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      await pending;

      expect(maxActive).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.OKH_JUDGE_CONCURRENCY;
      else process.env.OKH_JUDGE_CONCURRENCY = prev;
    }
  });

  it("does not launch unnecessary votes when judge concurrency exceeds k", async () => {
    const prev = process.env.OKH_JUDGE_CONCURRENCY;
    process.env.OKH_JUDGE_CONCURRENCY = "10";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maxActive = 0;
    const runner: CopilotRunner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      return { transcript: PASS_A, code: 0 };
    };
    try {
      const pending = runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 3, runner });
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      await pending;

      expect(maxActive).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.OKH_JUDGE_CONCURRENCY;
      else process.env.OKH_JUDGE_CONCURRENCY = prev;
    }
  });

  it("waits for concurrent judge calls and excludes a failed process from voting", async () => {
    let calls = 0;
    let slowSettled = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner: CopilotRunner = async () => {
      calls++;
      if (calls === 1) return { transcript: "", code: 1 };
      await gate;
      slowSettled = true;
      return { transcript: PASS_A, code: 0 };
    };

    const pending = runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 2, runner });
    setTimeout(release, 20);

    const result = await pending;
    expect(slowSettled).toBe(true);
    expect(result[0]).toMatchObject({ verdict: "UNRELIABLE", validVotes: 1, passVotes: 1 });
  });

  it("majority-votes each criterion across k runs", async () => {
    const runs = [
      '[{"id":"a","verdict":"PASS"},{"id":"b","verdict":"FAIL"}]',
      '[{"id":"a","verdict":"PASS"},{"id":"b","verdict":"PASS"}]',
      '[{"id":"a","verdict":"FAIL"},{"id":"b","verdict":"FAIL"}]',
    ];
    const res = await runJudgeCriteria(CRITERIA, "transcript", { k: 3, runner: seqRunner(runs) });
    const a = res.find((r) => r.id === "a")!;
    const b = res.find((r) => r.id === "b")!;
    expect(a.verdict).toBe("PASS"); // 2 PASS / 1 FAIL
    expect(a.passVotes).toBe(2);
    expect(b.verdict).toBe("FAIL"); // 1 PASS / 2 FAIL
  });

  it("stops after a configured majority PASS is fixed", async () => {
    let calls = 0;
    let telemetry: JudgeTelemetry | undefined;
    const result = await runJudgeCriteria([{ id: "a", text: "a" }], "t", {
      k: 3,
      runner: async () => {
        calls++;
        return { transcript: PASS_A, code: 0 };
      },
      onTelemetry: (value) => {
        telemetry = value;
      },
    });

    expect(calls).toBe(2);
    expect(result[0]).toMatchObject({
      verdict: "PASS",
      passVotes: 2,
      configuredVotes: 3,
      skippedVotes: 1,
      invalidVotes: 0,
    });
    expect(telemetry).toMatchObject({
      configuredRuns: 3,
      launchedRuns: 2,
      completedRuns: 2,
      skippedRuns: 1,
      invalidRuns: 0,
      durationMs: expect.any(Number),
    });
  });

  it("stops after a configured majority FAIL is fixed", async () => {
    let calls = 0;
    const fail = '[{"id":"a","verdict":"FAIL","evidence":"test evidence"}]';
    const result = await runJudgeCriteria([{ id: "a", text: "a" }], "t", {
      k: 3,
      runner: async () => {
        calls++;
        return { transcript: fail, code: 0 };
      },
    });

    expect(calls).toBe(2);
    expect(result[0]).toMatchObject({ verdict: "FAIL", failVotes: 2, skippedVotes: 1 });
  });

  it("stops when remaining runs cannot produce a configured majority", async () => {
    let calls = 0;
    const result = await runJudgeCriteria([{ id: "a", text: "a" }], "t", {
      k: 3,
      runner: async () => {
        calls++;
        return { transcript: "not json", code: 0 };
      },
    });

    expect(calls).toBe(2);
    expect(result[0]).toMatchObject({
      verdict: "UNRELIABLE",
      validVotes: 0,
      invalidVotes: 2,
      skippedVotes: 1,
    });
  });

  it("launches only the additional vote needed to fix a larger majority", async () => {
    let calls = 0;
    const result = await runJudgeCriteria([{ id: "a", text: "a" }], "t", {
      k: 5,
      runner: async () => {
        calls++;
        return { transcript: PASS_A, code: 0 };
      },
    });

    expect(calls).toBe(3);
    expect(result[0]).toMatchObject({ verdict: "PASS", passVotes: 3, skippedVotes: 2 });
  });

  it("passes with two valid PASS votes when one of three judge processes fails", async () => {
    const runs = [
      { transcript: PASS_A, code: 0 },
      { transcript: "", code: 1 },
      { transcript: PASS_A, code: 0 },
    ];
    let index = 0;
    const result = await runJudgeCriteria([{ id: "a", text: "a" }], "t", {
      k: 3,
      runner: async () => runs[index++]!,
    });
    expect(result[0]).toMatchObject({
      verdict: "PASS",
      passVotes: 2,
      validVotes: 2,
      invalidVotes: 1,
    });
  });

  it("requires a strict majority of configured runs", async () => {
    const runs = [
      '[{"id":"a","verdict":"PASS"}]',
      '[{"id":"a","verdict":"PASS"}]',
      '[{"id":"a","verdict":"FAIL"}]',
      "garbage",
      "garbage",
    ];
    const result = await runJudgeCriteria(
      [{ id: "a", text: "a" }],
      "t",
      { k: 5, runner: seqRunner(runs) },
    );
    expect(result[0]).toMatchObject({
      verdict: "UNRELIABLE",
      passVotes: 2,
      failVotes: 1,
      invalidVotes: 2,
    });
  });

  it("marks a criterion UNRELIABLE when every judge process exits non-zero", async () => {
    const runner: CopilotRunner = async () => ({ transcript: "", code: 1 });
    const result = await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 1, runner });
    expect(result[0]).toMatchObject({
      verdict: "UNRELIABLE",
      validVotes: 0,
      invalidVotes: 1,
      passVotes: 0,
      failVotes: 0,
      invalidReasons: [expect.stringMatching(/exit code 1/i)],
    });
  });

  it("propagates cancellation instead of converting it to an unreliable vote", async () => {
    const controller = new AbortController();
    const reason = new Error("stop grading");
    const runner: CopilotRunner = async () => {
      controller.abort(reason);
      return { transcript: "", code: null };
    };
    await expect(
      runJudgeCriteria([{ id: "a", text: "a" }], "t", {
        k: 3,
        runner,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("stop grading");
  });

  it("excludes unparseable runs from the vote", async () => {
    const runs = [
      '[{"id":"a","verdict":"PASS"}]',
      "no json at all",
      '[{"id":"a","verdict":"PASS"}]',
    ];
    const res = await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 3, runner: seqRunner(runs) });
    expect(res[0]!.verdict).toBe("PASS");
    expect(res[0]!.validVotes).toBe(2);
  });

  it.each([
    ["missing evidence", '[{"id":"a","verdict":"PASS"}]'],
    ["duplicate id", '[{"id":"a","verdict":"PASS","evidence":"x"},{"id":"a","verdict":"PASS","evidence":"y"}]'],
    ["extra id", '[{"id":"a","verdict":"PASS","evidence":"x"},{"id":"b","verdict":"PASS","evidence":"y"}]'],
  ])("rejects a judge response with %s", async (_label, transcript) => {
    const result = await runJudgeCriteria([{ id: "a", text: "a" }], "t", {
      k: 1,
      runner: async () => ({ transcript, code: 0 }),
    });
    expect(result[0]).toMatchObject({ verdict: "UNRELIABLE", validVotes: 0, invalidVotes: 1 });
    expect(result[0]!.invalidReasons).toHaveLength(1);
  });

  it("propagates unexpected runner failures", async () => {
    await expect(
      runJudgeCriteria([{ id: "a", text: "a" }], "t", {
        k: 1,
        runner: async () => {
          throw new Error("runner bug");
        },
      }),
    ).rejects.toThrow("runner bug");
  });

  it("marks a criterion UNRELIABLE when too few valid votes", async () => {
    const runs = ["garbage", "garbage", '[{"id":"a","verdict":"PASS"}]'];
    const res = await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 3, runner: seqRunner(runs) });
    expect(res[0]!.verdict).toBe("UNRELIABLE"); // 1 PASS < strict majority of 2
  });

  it("marks a tie UNRELIABLE", async () => {
    const runs = ['[{"id":"a","verdict":"PASS"}]', '[{"id":"a","verdict":"FAIL"}]'];
    const res = await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 2, runner: seqRunner(runs) });
    expect(res[0]!.verdict).toBe("UNRELIABLE"); // 1-1 tie
  });

  it("honors OKH_JUDGE_K when k is not passed", async () => {
    const prev = process.env.OKH_JUDGE_K;
    process.env.OKH_JUDGE_K = "1";
    try {
      let calls = 0;
      const runner: CopilotRunner = async () => { calls++; return { transcript: PASS_A, code: 0 }; };
      await runJudgeCriteria([{ id: "a", text: "a" }], "t", { runner });
      expect(calls).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.OKH_JUDGE_K;
      else process.env.OKH_JUDGE_K = prev;
    }
  });

  it("falls back to the default k when opts.k is invalid", async () => {
    let calls = 0;
    const runner: CopilotRunner = async () => {
      calls++;
      return { transcript: PASS_A, code: 0 };
    };
    const result = await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 0, runner });
    expect(calls).toBe(2);
    expect(result[0]).toMatchObject({ configuredVotes: 3, skippedVotes: 1 });
  });
});

describe("buildArtifactsSection", () => {
  const cleanups: string[] = [];
  async function pair(): Promise<{ fx: string; c: string }> {
    const fx = await makeTempDir("art-fx-");
    const c = await makeTempDir("art-");
    cleanups.push(fx, c);
    await mkdir(join(fx, "mem"), { recursive: true });
    await mkdir(join(c, "mem"), { recursive: true });
    await writeFile(join(fx, "mem", "2026-01-01.md"), "old entry\n", "utf8");
    await writeFile(join(c, "mem", "2026-01-01.md"), "old entry\n", "utf8"); // container starts as a copy
    return { fx, c };
  }

  it("includes only files new/changed vs the fixture baseline, with authoritative header", async () => {
    const { fx, c } = await pair();
    await writeFile(join(c, "mem", "2026-07-03.md"), "2026-07-03T00:00:00Z run #42 finished in 13s\n", "utf8");
    const out = await buildArtifactsSection({ containerPath: c, fixtureDir: fx }, { module: "mem" });
    expect(out).toMatch(/ON-DISK ARTIFACTS AFTER THE RUN/);
    expect(out).toContain("### mem/2026-07-03.md");
    expect(out).toContain("run #42 finished in 13s");
    expect(out).not.toContain("2026-01-01.md"); // unchanged fixture file excluded
  });

  it("includes all module files when no fixture baseline is provided", async () => {
    const { c } = await pair();
    const out = await buildArtifactsSection({ containerPath: c }, { module: "mem" });
    expect(out).toContain("### mem/2026-01-01.md");
    expect(out).toContain("old entry");
  });

  it("filters artifacts by case-insensitive file extension", async () => {
    const { c } = await pair();
    await writeFile(join(c, "mem", "deck.MD"), "deck\n", "utf8");
    await writeFile(join(c, "mem", "events.jsonl"), "event\n", "utf8");
    const out = await buildArtifactsSection(
      { containerPath: c },
      { module: "mem", extensions: [".md"] },
    );
    expect(out).toContain("deck.MD");
    expect(out).toContain("2026-01-01.md");
    expect(out).not.toContain("events.jsonl");
  });

  it("returns empty string when nothing was written or config is incomplete", async () => {
    const { fx, c } = await pair(); // container === fixture, nothing new
    expect(await buildArtifactsSection({ containerPath: c, fixtureDir: fx }, { module: "mem" })).toBe("");
    expect(await buildArtifactsSection({ containerPath: c }, {})).toBe(""); // no module
    expect(await buildArtifactsSection({}, { module: "mem" })).toBe(""); // no containerPath
  });

  it("truncates oversized file content", async () => {
    const c = await makeTempDir("art-big-");
    cleanups.push(c);
    await mkdir(join(c, "mem"), { recursive: true });
    await writeFile(join(c, "mem", "big.md"), "x".repeat(5000), "utf8");
    const out = await buildArtifactsSection({ containerPath: c }, { module: "mem", maxCharsPerFile: 100 });
    expect(out).toMatch(/…\[truncated\]/);
    expect(out.length).toBeLessThan(500);
  });

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
});
