import { join } from "node:path";
import { readTree, diffTrees } from "./_compare.js";

interface Ctx {
  config?: { module?: string };
  providerResponse?: { metadata?: { containerPath?: string; fixtureDir?: string } };
}

/**
 * Pass iff a module directory is byte-for-byte identical to its pristine fixture
 * — i.e. the run wrote nothing to it. Used by negative/guardrail scenarios (e.g.
 * `learn` rejecting non-goal input must NOT create a concept).
 */
export default async function moduleUnchanged(_output: string, context: Ctx) {
  const meta = context.providerResponse?.metadata ?? {};
  const module = context.config?.module ?? "kb";
  if (!meta.containerPath || !meta.fixtureDir) {
    return { pass: false, score: 0, reason: "missing containerPath/fixtureDir in metadata" };
  }
  const before = await readTree(join(meta.fixtureDir, module));
  const after = await readTree(join(meta.containerPath, module));
  const d = diffTrees(before, after);
  const pass = d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? `${module} unchanged`
      : `${module} changed — added[${d.added.join(", ")}] removed[${d.removed.join(", ")}] modified[${d.changed.join(", ")}]`,
  };
}
