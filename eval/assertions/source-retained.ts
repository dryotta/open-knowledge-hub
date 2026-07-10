import { join } from "node:path";
import { readdir } from "node:fs/promises";

interface Ctx {
  config?: { module?: string; dir?: string; filename?: string };
  providerResponse?: { metadata?: { containerPath?: string } };
}

/** Recursively collect file names under `dir` (empty if the dir is missing). */
async function walkNames(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkNames(p)));
    else if (e.isFile()) out.push(e.name);
  }
  return out;
}

/**
 * Pass iff a copy of the ingested source (config.filename) exists somewhere under
 * `<containerPath>/<module>/<dir>/` (default dir "sources") — i.e. the ingest skill
 * honored the module's retention policy.
 */
export default async function sourceRetained(_output: string, context: Ctx) {
  const containerPath = context.providerResponse?.metadata?.containerPath;
  const module = context.config?.module ?? "kb";
  const dir = context.config?.dir ?? "sources";
  const filename = context.config?.filename;
  if (!containerPath) return { pass: false, score: 0, reason: "no containerPath in metadata" };
  if (!filename) return { pass: false, score: 0, reason: "source-retained needs config.filename" };
  const root = join(containerPath, module, dir);
  const names = await walkNames(root);
  const pass = names.includes(filename);
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? `retained ${filename} under ${module}/${dir}/`
      : `no copy of ${filename} under ${module}/${dir}/ (found: ${names.join(", ") || "nothing"})`,
  };
}
