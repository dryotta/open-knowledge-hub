import { join } from "node:path";
import { runJudgeCriteria, type Criterion } from "../judge.js";
import { evaluateCheck, type Check } from "./checks.js";
import { readTree, diffTrees } from "./_compare.js";

interface ArtifactsConfig {
  /** Module directory (under the container) whose files the judge should see. */
  module?: string;
  /** Per-file content cap (chars) before truncation. Default 4000. */
  maxCharsPerFile?: number;
  /** Max number of files to include. Default 10. */
  maxFiles?: number;
}

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_MAX_FILES = 10;

/**
 * Read the files the agent wrote into `module` and format them for the judge.
 * When a fixture baseline is available, include only files that are new or
 * changed relative to it (i.e. exactly what this run produced); otherwise
 * include every file in the module. Returns "" when there is nothing to show.
 *
 * This grounds content-dependent rubrics ("the recorded entry contains only raw
 * facts") in the actual on-disk result, which the rendered transcript truncates.
 */
export async function buildArtifactsSection(
  meta: { containerPath?: string; fixtureDir?: string },
  cfg: ArtifactsConfig,
): Promise<string> {
  if (!cfg.module || !meta.containerPath) return "";
  const after = await readTree(join(meta.containerPath, cfg.module));
  let paths: string[];
  if (meta.fixtureDir) {
    const before = await readTree(join(meta.fixtureDir, cfg.module));
    const d = diffTrees(before, after);
    paths = [...d.added, ...d.changed].sort();
  } else {
    paths = [...after.keys()].sort();
  }
  if (paths.length === 0) return "";
  const maxChars = cfg.maxCharsPerFile ?? DEFAULT_MAX_CHARS;
  const maxFiles = cfg.maxFiles ?? DEFAULT_MAX_FILES;
  const blocks = paths.slice(0, maxFiles).map((p) => {
    const body = after.get(p) ?? "";
    const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n…[truncated]` : body;
    return `### ${cfg.module}/${p}\n${clipped}`;
  });
  return `\n\nON-DISK ARTIFACTS AFTER THE RUN (authoritative — the exact files the agent wrote):\n${blocks.join("\n\n")}`;
}

interface CriterionConfig {
  id: string;
  text: string;
  required?: boolean;
  check?: Check;
}

interface Ctx {
  config?: {
    criteria?: CriterionConfig[];
    k?: number;
    graderModel?: string;
    artifacts?: ArtifactsConfig;
  };
  providerResponse?: {
    metadata?: { containerPath?: string; fixtureDir?: string; okhHome?: string; toolCalls?: string[]; toolEvents?: import("../copilot.js").ToolEvent[] };
  };
}

/**
 * promptfoo `javascript` assertion. Grades the transcript against binary
 * `criteria` using a self-consistent Copilot-CLI judge (k runs, per-criterion
 * majority). Criteria carrying a `check` are cross-validated against deterministic
 * ground truth; a judge/deterministic disagreement fails and is flagged.
 */
export default async function judge(
  output: string,
  context: Ctx,
  deps: { runJudgeCriteria: typeof runJudgeCriteria } = { runJudgeCriteria },
) {
  const criteria = context.config?.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { pass: false, score: 0, reason: "no criteria provided in assertion config" };
  }
  const meta = context.providerResponse?.metadata ?? {};
  let graded = output;
  if (context.config?.artifacts) {
    graded += await buildArtifactsSection(meta, context.config.artifacts);
  }
  const results = await deps.runJudgeCriteria(criteria as Criterion[], graded, {
    ...(context.config?.k ? { k: context.config.k } : {}),
    ...(context.config?.graderModel ? { model: context.config.graderModel } : {}),
  });
  const byId = new Map(results.map((r) => [r.id, r]));
  const checkCtx = { okhHome: meta.okhHome, toolCalls: meta.toolCalls ?? [], toolEvents: meta.toolEvents ?? [], transcript: output };

  const parts: string[] = [];
  let pass = true;
  for (const c of criteria) {
    const r = byId.get(c.id);
    const required = c.required !== false;

    if (c.check) {
      // Deterministic check is authoritative: always run it, use its verdict regardless of judge.
      const det = await evaluateCheck(c.check, checkCtx);
      const judgeVerdict: string = r ? r.verdict : "MISSING";
      const detVerdict = det.pass ? "PASS" : "FAIL";
      // Required gates on det; advisory never gates.
      if (required && !det.pass) pass = false;
      const border = r?.verdict === "PASS" && r.failVotes > 0 ? " (borderline)" : "";
      const advisoryTag = required ? "" : " [advisory]";
      parts.push(`${c.id}: ${detVerdict} det=${detVerdict}(${det.reason}) judge=${judgeVerdict}${border}${advisoryTag}`);
      continue;
    }

    // Unchecked semantic criteria: preserve existing required/advisory behaviour.
    if (!r) {
      parts.push(`${c.id}: MISSING`);
      if (required) pass = false;
      continue;
    }
    const effective: "PASS" | "FAIL" | "UNRELIABLE" = r.verdict;
    if (required && effective !== "PASS") pass = false;
    const border = r.verdict === "PASS" && r.failVotes > 0 ? " (borderline)" : "";
    parts.push(`${c.id}: ${effective} ${r.passVotes}/${r.validVotes}${border}${required ? "" : " [advisory]"}`);
  }
  return { pass, score: pass ? 1 : 0, reason: parts.join(" · ") };
}
