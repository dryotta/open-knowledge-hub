import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCopilot, type CopilotRunner } from "./copilot.js";

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
  evidence: string[];
}

const MAX_JUDGE_K = 11;

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
  opts: { model?: string; timeoutMs?: number; runner?: CopilotRunner },
): Promise<string> {
  const runner = opts.runner ?? spawnCopilot;
  const root = await mkdtemp(join(tmpdir(), "okh-judge-"));
  const copilotHome = join(root, "copilot-home");
  const workspace = join(root, "workspace");
  await mkdir(copilotHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    const res = await runner({
      prompt,
      model: opts.model ?? "claude-sonnet-4.5",
      copilotHome,
      cwd: workspace,
      timeoutMs: opts.timeoutMs ?? 180_000,
    });
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

/**
 * Grade a transcript against binary criteria using k independent Copilot-CLI judge
 * runs, then majority-vote each criterion. A run whose output doesn't parse (or
 * omits a criterion) does not vote for it. A criterion with fewer than ceil(k/2)
 * valid votes, or a tie, is UNRELIABLE. k defaults to opts.k, else OKH_JUDGE_K, else 3.
 */
export async function runJudgeCriteria(
  criteria: Criterion[],
  transcript: string,
  opts: { k?: number; model?: string; timeoutMs?: number; runner?: CopilotRunner } = {},
): Promise<CriterionResult[]> {
  const k = resolveK(opts.k);
  const prompt = gradeCriteriaPrompt(criteria, transcript);
  const votes: Array<Map<string, "PASS" | "FAIL">> = [];
  const evidence = new Map<string, string[]>();
  for (let i = 0; i < k; i++) {
    const raw = await judgeOnce(prompt, opts);
    const arr = extractJsonArray(raw);
    if (!arr) continue;
    const m = new Map<string, "PASS" | "FAIL">();
    for (const item of arr) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>;
        const id = rec.id;
        const v = rec.verdict;
        if (typeof id === "string" && (v === "PASS" || v === "FAIL")) {
          m.set(id, v);
          if (typeof rec.evidence === "string" && rec.evidence) {
            const l = evidence.get(id) ?? [];
            l.push(rec.evidence);
            evidence.set(id, l);
          }
        }
      }
    }
    votes.push(m);
  }
  const need = Math.ceil(k / 2);
  return criteria.map((c) => {
    let passVotes = 0;
    let failVotes = 0;
    for (const m of votes) {
      const v = m.get(c.id);
      if (v === "PASS") passVotes++;
      else if (v === "FAIL") failVotes++;
    }
    const validVotes = passVotes + failVotes;
    let verdict: CriterionResult["verdict"];
    if (validVotes < need) verdict = "UNRELIABLE";
    else if (passVotes > failVotes) verdict = "PASS";
    else if (failVotes > passVotes) verdict = "FAIL";
    else verdict = "UNRELIABLE";
    return { id: c.id, verdict, passVotes, failVotes, validVotes, evidence: evidence.get(c.id) ?? [] };
  });
}
