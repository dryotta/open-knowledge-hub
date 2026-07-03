import { join } from "node:path";
import { readdir } from "node:fs/promises";

interface Ctx {
  config?: { module?: string; baselineFileCount?: number };
  providerResponse?: { metadata?: { containerPath?: string } };
}

/**
 * Pass iff the memory module's markdown file count grew beyond the baseline —
 * i.e. `remember` created a new dated entry file. (The memory format is
 * provisional; scenarios seed a known baseline count.)
 */
export default async function memoryAppend(_output: string, context: Ctx) {
  const containerPath = context.providerResponse?.metadata?.containerPath;
  const module = context.config?.module ?? "mem";
  const baseline = context.config?.baselineFileCount ?? 0;
  if (!containerPath) return { pass: false, score: 0, reason: "no containerPath in metadata" };
  let files: string[] = [];
  try {
    files = (await readdir(join(containerPath, module))).filter((f) => f.endsWith(".md"));
  } catch {
    files = [];
  }
  const pass = files.length > baseline;
  return { pass, score: pass ? 1 : 0, reason: `memory .md files: ${files.length} (baseline ${baseline}, need > ${baseline})` };
}
