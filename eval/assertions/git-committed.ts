import { run } from "../../src/exec.js";

interface Ctx {
  config?: { minCommits?: number; minNewCommits?: number };
  providerResponse?: {
    metadata?: {
      originPath?: string;
      baselineCommitCount?: number;
    };
  };
}

/** Pass iff the git-auto container's bare origin received commits beyond the seed (i.e. sync pushed). */
export default async function gitCommitted(_output: string, context: Ctx) {
  const origin = context.providerResponse?.metadata?.originPath;
  if (!origin) return { pass: false, score: 0, reason: "no origin (not a git-auto container)" };
  const baseline = context.providerResponse?.metadata?.baselineCommitCount ?? 1;
  const min = context.config?.minCommits
    ?? baseline + (context.config?.minNewCommits ?? 1);
  let count = 0;
  try {
    const { stdout } = await run("git", ["--git-dir", origin, "log", "--oneline"]);
    count = stdout.trim().split(/\r?\n/).filter(Boolean).length;
  } catch (err) {
    return { pass: false, score: 0, reason: `git log failed: ${(err as Error).message}` };
  }
  const pass = count >= min;
  return { pass, score: pass ? 1 : 0, reason: `origin commits: ${count} (need >= ${min})` };
}
