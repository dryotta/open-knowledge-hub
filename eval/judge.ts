import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCopilot, type CopilotRunner } from "./copilot.js";
import { validateRunId } from "./environments.js";

export interface Criterion {
  id: string;
  text: string;
  required?: boolean;
  check?: unknown; // opaque here; interpreted by the judge assertion via checks.ts
}

export interface CriterionResult {
  id: string;
  verdict: "PASS" | "FAIL" | "UNRELIABLE";
  passVotes: number;
  failVotes: number;
  validVotes: number;
  invalidVotes: number;
  invalidReasons: string[];
  evidence: string[];
}

const MAX_JUDGE_K = 11;
const DEFAULT_JUDGE_MODEL = "gpt-5.6-luna";

class JudgeProcessError extends Error {}

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

/** Run one `copilot -p` grading call in an isolated, empty COPILOT_HOME; return raw stdout. */
async function judgeOnce(
  prompt: string,
  opts: { model?: string; timeoutMs?: number; runner?: CopilotRunner; abortSignal?: AbortSignal },
): Promise<string> {
  const runner = opts.runner ?? spawnCopilot;
  const runId = process.env.OKH_EVAL_RUN_ID;
  if (runId) validateRunId(runId);
  const root = await mkdtemp(join(tmpdir(), runId ? `okh-eval-${runId}-judge-` : "okh-judge-"));
  const copilotHome = join(root, "copilot-home");
  const workspace = join(root, "workspace");
  await mkdir(copilotHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    const res = await runner({
      prompt,
      model: opts.model ?? process.env.OKH_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
      copilotHome,
      cwd: workspace,
      timeoutMs: opts.timeoutMs ?? 180_000,
      abortSignal: opts.abortSignal,
    });
    if (res.processFailure || res.code !== 0) {
      const code = res.code === null ? "missing" : String(res.code);
      throw new JudgeProcessError(
        res.processFailure
          ? `Judge process failed with exit code ${code}: ${res.processFailure}`
          : `Judge process failed with exit code ${code}`,
      );
    }
    return res.transcript;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function gradeCriteriaPrompt(criteria: Criterion[], transcript: string): string {
  const list = criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n");
  return `You are grading an AI agent's run against a checklist of yes/no criteria. Judge ONLY from the transcript.
Respond with ONLY a JSON array (no prose, no code fences), exactly one object per criterion:
[{"id":"<criterion id>","verdict":"PASS"|"FAIL","evidence":"<short quote or reason>"}]
Include every criterion id exactly once. "verdict" must be exactly "PASS" or "FAIL".

CRITERIA:
${list}

AGENT TRANSCRIPT (what the agent did and said):
${transcript}`;
}

function resolveK(optsK?: number): number {
  const raw = optsK ?? Number(process.env.OKH_JUDGE_K);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), MAX_JUDGE_K) : 3;
}

function resolveConcurrency(k: number): number {
  const raw = Number(process.env.OKH_JUDGE_CONCURRENCY);
  return Number.isInteger(raw) && raw >= 1 ? Math.min(raw, k) : Math.min(k, 2);
}

type ParsedJudgeRun =
  | { ok: true; votes: Map<string, "PASS" | "FAIL">; evidence: Map<string, string> }
  | { ok: false; reason: string };

function parseJudgeRun(raw: string, criteria: Criterion[]): ParsedJudgeRun {
  const items = extractJsonArray(raw);
  if (!items) return { ok: false, reason: "Judge output did not contain a JSON array" };
  if (items.length !== criteria.length) {
    return {
      ok: false,
      reason: `Judge output contained ${items.length} entries; expected ${criteria.length}`,
    };
  }

  const expectedIds = new Set(criteria.map((criterion) => criterion.id));
  const votes = new Map<string, "PASS" | "FAIL">();
  const evidence = new Map<string, string>();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, reason: "Judge output contained a non-object entry" };
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !expectedIds.has(record.id)) {
      return { ok: false, reason: `Judge output contained unknown criterion id ${JSON.stringify(record.id)}` };
    }
    if (votes.has(record.id)) {
      return { ok: false, reason: `Judge output duplicated criterion id ${JSON.stringify(record.id)}` };
    }
    if (record.verdict !== "PASS" && record.verdict !== "FAIL") {
      return { ok: false, reason: `Judge output had an invalid verdict for ${record.id}` };
    }
    if (typeof record.evidence !== "string" || !record.evidence.trim()) {
      return { ok: false, reason: `Judge output omitted evidence for ${record.id}` };
    }
    votes.set(record.id, record.verdict);
    evidence.set(record.id, record.evidence.trim());
  }
  return { ok: true, votes, evidence };
}

/**
 * Grade a transcript against binary criteria using k independent Copilot-CLI judge
 * runs, then majority-vote each criterion. A run whose output doesn't parse (or
 * whose process fails, or violates the response schema) does not vote. PASS or
 * FAIL requires a strict majority of the configured k runs; otherwise the result
 * is UNRELIABLE. k defaults to opts.k, else OKH_JUDGE_K, else 3.
 */
export async function runJudgeCriteria(
  criteria: Criterion[],
  transcript: string,
  opts: { k?: number; model?: string; timeoutMs?: number; runner?: CopilotRunner; abortSignal?: AbortSignal } = {},
): Promise<CriterionResult[]> {
  if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) {
    throw new Error("Judge criteria ids must be unique");
  }
  const k = resolveK(opts.k);
  const concurrency = resolveConcurrency(k);
  const prompt = gradeCriteriaPrompt(criteria, transcript);
  const votes: Array<Map<string, "PASS" | "FAIL">> = [];
  const evidence = new Map<string, string[]>();
  const invalidReasons: string[] = [];
  const raws = new Array<string | undefined>(k);
  let next = 0;
  let aborted = false;
  let fatal = false;
  const fatalErrors: unknown[] = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (!aborted && !fatal && next < k) {
        const index = next++;
        try {
          raws[index] = await judgeOnce(prompt, opts);
        } catch (error) {
          if (opts.abortSignal?.aborted) aborted = true;
          else if (error instanceof JudgeProcessError) {
            invalidReasons.push(error.message);
          } else {
            fatal = true;
            fatalErrors.push(error);
          }
        }
      }
    }),
  );
  if (opts.abortSignal?.aborted) {
    throw opts.abortSignal.reason ?? new Error("Judge grading aborted");
  }
  if (fatalErrors.length === 1) throw fatalErrors[0];
  if (fatalErrors.length > 1) {
    throw new AggregateError(fatalErrors, "Multiple judge runs failed unexpectedly");
  }
  for (const raw of raws) {
    if (raw === undefined) continue;
    const parsed = parseJudgeRun(raw, criteria);
    if (!parsed.ok) {
      invalidReasons.push(parsed.reason);
      continue;
    }
    votes.push(parsed.votes);
    for (const [id, reason] of parsed.evidence) {
      const reasons = evidence.get(id) ?? [];
      reasons.push(reason);
      evidence.set(id, reasons);
    }
  }
  const need = Math.floor(k / 2) + 1;
  return criteria.map((c) => {
    let passVotes = 0;
    let failVotes = 0;
    for (const vote of votes) {
      const verdict = vote.get(c.id);
      if (verdict === "PASS") passVotes++;
      else if (verdict === "FAIL") failVotes++;
    }
    const validVotes = passVotes + failVotes;
    const invalidVotes = k - validVotes;
    let verdict: CriterionResult["verdict"];
    if (passVotes >= need) verdict = "PASS";
    else if (failVotes >= need) verdict = "FAIL";
    else verdict = "UNRELIABLE";
    return {
      id: c.id,
      verdict,
      passVotes,
      failVotes,
      validVotes,
      invalidVotes,
      invalidReasons,
      evidence: evidence.get(c.id) ?? [],
    };
  });
}
