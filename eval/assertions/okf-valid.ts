import { join, basename } from "node:path";
import { readFile } from "node:fs/promises";
import { parseFrontmatter, stringField } from "../../src/util/frontmatter.js";
import { readTree, diffTrees } from "./_compare.js";

interface Ctx {
  config?: {
    module?: string;
    requireCitations?: boolean;
    requireChanged?: boolean;
    requiredChangedPatterns?: string[];
  };
  providerResponse?: { metadata?: { containerPath?: string; fixtureDir?: string } };
}
const RESERVED = new Set(["index.md", "log.md"]);

function isConceptPath(path: string): boolean {
  const name = path.replace(/\\/gu, "/").split("/").at(-1)?.toLowerCase() ?? "";
  return path.toLowerCase().endsWith(".md") && !RESERVED.has(name);
}

async function walkMd(dir: string): Promise<string[]> {
  const tree = await readTree(dir);
  return [...tree.keys()].filter((p) => p.toLowerCase().endsWith(".md")).map((p) => join(dir, p));
}

/** Pass iff every concept doc in the knowledge module parses with a non-empty OKF `type`. */
export default async function okfValid(_output: string, context: Ctx) {
  const containerPath = context.providerResponse?.metadata?.containerPath;
  const module = context.config?.module ?? "kb";
  if (!containerPath) return { pass: false, score: 0, reason: "no containerPath in metadata" };
  const root = join(containerPath, module);
  const concepts = (await walkMd(root)).filter((f) => !RESERVED.has(basename(f).toLowerCase()));
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
  if (context.config?.requireChanged || context.config?.requiredChangedPatterns?.length) {
    const fixtureDir = context.providerResponse?.metadata?.fixtureDir;
    if (!fixtureDir) {
      problems.push("cannot verify module change: no fixtureDir in metadata");
    } else {
      const after = await readTree(root);
      const d = diffTrees(await readTree(join(fixtureDir, module)), after);
      const changedConceptPaths = [...d.added, ...d.changed].filter(isConceptPath);
      if (changedConceptPaths.length === 0) {
        problems.push("no concept document was added or changed");
      }
      const changedText = changedConceptPaths
        .map((path) => after.get(path) ?? "")
        .join("\n");
      for (const pattern of context.config?.requiredChangedPatterns ?? []) {
        try {
          if (!new RegExp(pattern, "i").test(changedText)) {
            problems.push(`changed content missing /${pattern}/`);
          }
        } catch {
          problems.push(`invalid requiredChangedPatterns regex /${pattern}/`);
        }
      }
    }
  }
  const pass = problems.length === 0;
  return { pass, score: pass ? 1 : 0, reason: pass ? `OKF valid (${concepts.length} concepts)` : problems.join("; ") };
}
