import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCopilot, type CopilotRunner } from "./copilot.js";

export interface JudgeVerdict {
  pass: boolean;
  score: number;
  reason: string;
  raw: string;
}

/**
 * Return the last top-level balanced JSON object in `text` that parses to an
 * object, or null. Tolerant of surrounding prose / code fences / reasoning that a
 * `copilot -p` grading call may emit before the final verdict.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const objs: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        objs.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (let k = objs.length - 1; k >= 0; k--) {
    try {
      const o = JSON.parse(objs[k]!);
      if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Return the last top-level balanced JSON array in `text` that parses to an
 * array, or null. Mirrors extractJson but for the judge's per-criterion output.
 */
export function extractJsonArray(text: string): unknown[] | null {
  const arrs: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        arrs.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (let k = arrs.length - 1; k >= 0; k--) {
    try {
      const a = JSON.parse(arrs[k]!);
      if (Array.isArray(a)) return a;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function gradePrompt(rubric: string, transcript: string): string {
  return `You are grading an AI agent's run against a rubric. Judge ONLY from the transcript.
Respond with ONLY a JSON object (no prose, no code fences):
{"pass": <true|false>, "score": <number between 0 and 1>, "reason": "<one short sentence>"}
A score >= 0.8 means the run meets the rubric.

RUBRIC:
${rubric}

AGENT TRANSCRIPT (what the agent did and said):
${transcript}`;
}

/**
 * Grade a transcript against a rubric using GitHub Copilot CLI as the judge
 * (no external model key). Runs `copilot -p` in an isolated, empty COPILOT_HOME.
 */
export async function runJudge(
  rubric: string,
  transcript: string,
  opts: { model?: string; timeoutMs?: number; runner?: CopilotRunner } = {},
): Promise<JudgeVerdict> {
  const runner = opts.runner ?? spawnCopilot;
  const root = await mkdtemp(join(tmpdir(), "okh-judge-"));
  const copilotHome = join(root, "copilot-home");
  const workspace = join(root, "workspace");
  await mkdir(copilotHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    const res = await runner({
      prompt: gradePrompt(rubric, transcript),
      model: opts.model ?? "claude-sonnet-4.5",
      copilotHome,
      cwd: workspace,
      timeoutMs: opts.timeoutMs ?? 180_000,
    });
    const parsed = extractJson(res.transcript);
    const score = parsed && typeof parsed.score === "number" ? parsed.score : NaN;
    if (!parsed || Number.isNaN(score)) {
      return { pass: false, score: 0, reason: "judge returned unparseable output", raw: res.transcript };
    }
    return {
      pass: parsed.pass === true,
      score,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      raw: res.transcript,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
