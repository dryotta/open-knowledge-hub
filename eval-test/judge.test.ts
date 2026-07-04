import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../test/helpers.js";
import { extractJson, extractJsonArray, runJudge } from "../eval/judge.js";
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

const fakeRunner = (transcript: string): CopilotRunner => async () => ({ transcript, code: 0 });

describe("runJudge", () => {
  it("parses a strict-JSON verdict from the judge output", async () => {
    const v = await runJudge("rubric", "transcript", {
      runner: fakeRunner('Here is my verdict: {"pass":true,"score":0.95,"reason":"great"}'),
    });
    expect(v.pass).toBe(true);
    expect(v.score).toBe(0.95);
    expect(v.reason).toBe("great");
  });
  it("fails safe on unparseable judge output", async () => {
    const v = await runJudge("rubric", "transcript", { runner: fakeRunner("I think it is fine, no json") });
    expect(v.pass).toBe(false);
    expect(v.score).toBe(0);
    expect(v.reason).toMatch(/unparseable/i);
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
