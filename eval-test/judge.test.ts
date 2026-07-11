import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../test/helpers.js";
import { extractJson, extractJsonArray, runJudgeCriteria } from "../eval/judge.js";
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

function seqRunner(outputs: string[]): CopilotRunner {
  let i = 0;
  return async () => ({ transcript: outputs[Math.min(i++, outputs.length - 1)]!, code: 0 });
}

const CRITERIA = [
  { id: "a", text: "criterion a" },
  { id: "b", text: "criterion b" },
];

describe("runJudgeCriteria", () => {
  it("uses GPT-5.6 Luna as the default judge model", async () => {
    const prev = process.env.OKH_JUDGE_MODEL;
    delete process.env.OKH_JUDGE_MODEL;
    try {
      let model: string | undefined;
      const runner: CopilotRunner = async (opts) => {
        model = opts.model;
        return { transcript: '[{"id":"a","verdict":"PASS"}]', code: 0 };
      };

      await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 1, runner });

      expect(model).toBe("gpt-5.6-luna");
    } finally {
      if (prev === undefined) delete process.env.OKH_JUDGE_MODEL;
      else process.env.OKH_JUDGE_MODEL = prev;
    }
  });

  it("uses OKH_JUDGE_MODEL unless an explicit model is provided", async () => {
    const prev = process.env.OKH_JUDGE_MODEL;
    process.env.OKH_JUDGE_MODEL = "claude-haiku-4.5";
    try {
      const models: Array<string | undefined> = [];
      const runner: CopilotRunner = async (opts) => {
        models.push(opts.model);
        return { transcript: '[{"id":"a","verdict":"PASS"}]', code: 0 };
      };

      await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 1, runner });
      await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 1, model: "claude-sonnet-4.5", runner });

      expect(models).toEqual(["claude-haiku-4.5", "claude-sonnet-4.5"]);
    } finally {
      if (prev === undefined) delete process.env.OKH_JUDGE_MODEL;
      else process.env.OKH_JUDGE_MODEL = prev;
    }
  });

  it("runs all judge votes concurrently by default", async () => {
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
      return { transcript: '[{"id":"a","verdict":"PASS"}]', code: 0 };
    };
    try {
      const pending = runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 3, runner });
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      await pending;

      expect(maxActive).toBe(3);
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
      return { transcript: '[{"id":"a","verdict":"PASS"}]', code: 0 };
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
      return { transcript: '[{"id":"a","verdict":"PASS"}]', code: 0 };
    };
    try {
      const pending = runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 3, runner });
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      await pending;

      expect(maxActive).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.OKH_JUDGE_CONCURRENCY;
      else process.env.OKH_JUDGE_CONCURRENCY = prev;
    }
  });

  it("clamps OKH_JUDGE_CONCURRENCY to k", async () => {
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
      return { transcript: '[{"id":"a","verdict":"PASS"}]', code: 0 };
    };
    try {
      const pending = runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 3, runner });
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      await pending;

      expect(maxActive).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.OKH_JUDGE_CONCURRENCY;
      else process.env.OKH_JUDGE_CONCURRENCY = prev;
    }
  });

  it("waits for concurrent judge calls to settle before propagating a failure", async () => {
    let calls = 0;
    let slowSettled = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner: CopilotRunner = async () => {
      calls++;
      if (calls === 1) return { transcript: "", code: 1 };
      await gate;
      slowSettled = true;
      return { transcript: '[{"id":"a","verdict":"PASS"}]', code: 0 };
    };

    const pending = runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 2, runner });
    setTimeout(release, 20);

    await expect(pending).rejects.toThrow(/judge.*exit code 1/i);
    expect(slowSettled).toBe(true);
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

  it("rejects when judge process exits non-zero", async () => {
    const runner: CopilotRunner = async () => ({ transcript: "", code: 1 });
    await expect(
      runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 1, runner }),
    ).rejects.toThrow(/judge.*exit code 1/i);
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

  it("marks a criterion UNRELIABLE when too few valid votes", async () => {
    const runs = ["garbage", "garbage", '[{"id":"a","verdict":"PASS"}]'];
    const res = await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 3, runner: seqRunner(runs) });
    expect(res[0]!.verdict).toBe("UNRELIABLE"); // 1 valid < ceil(3/2)=2
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
      const runner: CopilotRunner = async () => { calls++; return { transcript: '[{"id":"a","verdict":"PASS"}]', code: 0 }; };
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
      return { transcript: '[{"id":"a","verdict":"PASS"}]', code: 0 };
    };
    await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 0, runner });
    expect(calls).toBe(3);
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
