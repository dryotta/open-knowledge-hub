import { describe, it, expect } from "vitest";
import { extractJson, runJudge } from "../eval/judge.js";
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
