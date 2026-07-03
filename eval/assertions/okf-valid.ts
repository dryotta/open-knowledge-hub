import { join, basename } from "node:path";
import { readFile } from "node:fs/promises";
import { parseFrontmatter, stringField } from "../../src/util/frontmatter.js";
import { readTree, diffTrees } from "./_compare.js";

interface Ctx {
  config?: { module?: string; requireCitations?: boolean; requireChanged?: boolean };
  providerResponse?: { metadata?: { containerPath?: string; fixtureDir?: string } };
}
const RESERVED = new Set(["index.md", "log.md"]);

async function walkMd(dir: string): Promise<string[]> {
  const tree = await readTree(dir);
  return [...tree.keys()].filter((p) => p.endsWith(".md")).map((p) => join(dir, p));
}

/** Pass iff every concept doc in the knowledge module parses with a non-empty OKF `type`. */
export default async function okfValid(_output: string, context: Ctx) {
  const containerPath = context.providerResponse?.metadata?.containerPath;
  const module = context.config?.module ?? "kb";
  if (!containerPath) return { pass: false, score: 0, reason: "no containerPath in metadata" };
  const root = join(containerPath, module);
  const concepts = (await walkMd(root)).filter((f) => !RESERVED.has(basename(f)));
  if (concepts.length === 0) return { pass: false, score: 0, reason: `no concept docs in ${module}` };
  const problems: string[] = [];
  let hasCitations = false;
  for (const f of concepts) {
    const text = await readFile(f, "utf8");
    const { data, body } = parseFrontmatter(text);
    if (!stringField(data, "type")) problems.push(`${basename(f)}: missing frontmatter type`);
    if (/^#\s*Citations/im.test(body)) hasCitations = true;
  }
  if (context.config?.requireCitations && !hasCitations) problems.push("no concept has a # Citations section");
  if (context.config?.requireChanged) {
    const fixtureDir = context.providerResponse?.metadata?.fixtureDir;
    if (!fixtureDir) {
      problems.push("cannot verify module change: no fixtureDir in metadata");
    } else {
      const d = diffTrees(await readTree(join(fixtureDir, module)), await readTree(root));
      if (d.added.length === 0 && d.changed.length === 0) {
        problems.push("knowledge module was not modified (learn wrote nothing new)");
      }
    }
  }
  const pass = problems.length === 0;
  return { pass, score: pass ? 1 : 0, reason: pass ? `OKF valid (${concepts.length} concepts)` : problems.join("; ") };
}
