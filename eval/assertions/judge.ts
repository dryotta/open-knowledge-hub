import { join } from "node:path";
import { runJudge } from "../judge.js";
import { readTree, diffTrees } from "./_compare.js";

interface ArtifactsConfig {
  /** Module directory (under the container) whose files the judge should see. */
  module?: string;
  /** Per-file content cap (chars) before truncation. Default 4000. */
  maxCharsPerFile?: number;
  /** Max number of files to include. Default 10. */
  maxFiles?: number;
}

interface Ctx {
  config?: {
    rubric?: string;
    threshold?: number;
    graderModel?: string;
    artifacts?: ArtifactsConfig;
  };
  providerResponse?: { metadata?: { containerPath?: string; fixtureDir?: string } };
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

/**
 * promptfoo `javascript` assertion that grades the agent transcript against the
 * scenario's rubric using GitHub Copilot CLI as the judge (no external API key).
 * Passes iff the judge's score meets the threshold (default 0.8).
 *
 * When `config.artifacts.module` is set, the exact files the agent wrote to that
 * module are appended to what the judge sees, so rubrics can grade file content
 * that the transcript does not reliably surface.
 */
export default async function judge(output: string, context: Ctx) {
  const rubric = context.config?.rubric ?? "";
  const threshold = context.config?.threshold ?? 0.8;
  if (!rubric.trim()) return { pass: false, score: 0, reason: "no rubric provided in assertion config" };
  let graded = output;
  if (context.config?.artifacts) {
    graded += await buildArtifactsSection(context.providerResponse?.metadata ?? {}, context.config.artifacts);
  }
  const v = await runJudge(rubric, graded, {
    ...(context.config?.graderModel ? { model: context.config.graderModel } : {}),
  });
  const pass = v.score >= threshold;
  return { pass, score: v.score, reason: `judge(${v.score.toFixed(2)}≥${threshold}? ${pass}): ${v.reason}` };
}
