import { join } from "node:path";
import { readTree, diffTrees } from "./_compare.js";

interface Ctx {
  config?: { module?: string; baselineFileCount?: number };
  providerResponse?: { metadata?: { containerPath?: string; fixtureDir?: string } };
}

/**
 * Pass iff the memory module gained a new markdown entry (file count grew beyond
 * the baseline) AND remained append-only: every pre-existing fixture memory file
 * is still present and byte-identical (no history rewritten/deleted).
 */
export default async function memoryAppend(_output: string, context: Ctx) {
  const meta = context.providerResponse?.metadata ?? {};
  const module = context.config?.module ?? "mem";
  const baseline = context.config?.baselineFileCount ?? 0;
  if (!meta.containerPath) return { pass: false, score: 0, reason: "no containerPath in metadata" };

  const after = await readTree(join(meta.containerPath, module));
  const mdCount = [...after.keys()].filter((f) => f.endsWith(".md")).length;
  const grew = mdCount > baseline;

  let rewritten: string[] = [];
  if (meta.fixtureDir) {
    const before = await readTree(join(meta.fixtureDir, module));
    const d = diffTrees(before, after);
    rewritten = [...d.changed, ...d.removed];
  }

  const pass = grew && rewritten.length === 0;
  const reason = !grew
    ? `memory .md files: ${mdCount} (need > ${baseline})`
    : rewritten.length > 0
      ? `append-only violated (prior entries changed/removed): ${rewritten.join(", ")}`
      : `appended (memory .md files: ${mdCount} > ${baseline}); prior entries intact`;
  return { pass, score: pass ? 1 : 0, reason };
}
