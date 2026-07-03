import { join, basename } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { parseFrontmatter, stringField } from "../../src/util/frontmatter.js";

interface Ctx {
  config?: { module?: string; requireCitations?: boolean; requireIndexUpdated?: boolean };
  providerResponse?: { metadata?: { containerPath?: string; fixtureDir?: string } };
}
const RESERVED = new Set(["index.md", "log.md"]);

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git" && e.name !== ".okh") await rec(p);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(p);
      }
    }
  }
  await rec(dir);
  return out;
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
  if (context.config?.requireIndexUpdated) {
    const fixtureDir = context.providerResponse?.metadata?.fixtureDir;
    if (!fixtureDir) {
      problems.push("cannot verify index.md update: no fixtureDir in metadata");
    } else {
      const now = await readFile(join(root, "index.md"), "utf8").catch(() => "");
      const orig = await readFile(join(fixtureDir, module, "index.md"), "utf8").catch(() => "");
      if (now === orig) problems.push("index.md was not updated to reference the new concept");
    }
  }
  const pass = problems.length === 0;
  return { pass, score: pass ? 1 : 0, reason: pass ? `OKF valid (${concepts.length} concepts)` : problems.join("; ") };
}
