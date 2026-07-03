import { runJudge } from "../judge.js";

interface Ctx {
  config?: { rubric?: string; threshold?: number; graderModel?: string };
}

/**
 * promptfoo `javascript` assertion that grades the agent transcript against the
 * scenario's rubric using GitHub Copilot CLI as the judge (no external API key).
 * Passes iff the judge's score meets the threshold (default 0.8).
 */
export default async function judge(output: string, context: Ctx) {
  const rubric = context.config?.rubric ?? "";
  const threshold = context.config?.threshold ?? 0.8;
  if (!rubric.trim()) return { pass: false, score: 0, reason: "no rubric provided in assertion config" };
  const v = await runJudge(rubric, output, { ...(context.config?.graderModel ? { model: context.config.graderModel } : {}) });
  const pass = v.score >= threshold;
  return { pass, score: v.score, reason: `judge(${v.score.toFixed(2)}≥${threshold}? ${pass}): ${v.reason}` };
}
