import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, basename, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, stringField } from "../../util/frontmatter.js";
import { walkFiles } from "../fs.js";
import { okfEnumerate, OKF_RESERVED } from "./okf.js";
import type { Item, Loader, WikiHealth } from "../types.js";

const INDEX_SKELETON_URL = new URL("../../../resources/module-types/llmwiki/index-skeleton.md", import.meta.url);
const LOG_SEED = "# Update Log\n\n<!-- Newest entries first. Each entry: `## YYYY-MM-DD` then bullets. -->\n";

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function enumerate(moduleRoot: string): Promise<Item[]> {
  return okfEnumerate(moduleRoot, "page");
}

async function overview(moduleRoot: string): Promise<string> {
  try {
    return await readFile(join(moduleRoot, "index.md"), "utf8");
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  const items = await enumerate(moduleRoot);
  if (items.length === 0) return "# Wiki\n\n_Empty wiki (no index.md, no pages)._\n";
  const lines = items.map((i) => `* ${i.title}${i.description ? ` — ${i.description}` : ""} (\`${i.path}\`)`);
  return `# Wiki (generated index)\n\n${lines.join("\n")}\n`;
}

async function scaffold(moduleRoot: string): Promise<void> {
  await mkdir(moduleRoot, { recursive: true });
  const skeleton = await readFile(fileURLToPath(INDEX_SKELETON_URL), "utf8");
  await writeFile(join(moduleRoot, "index.md"), skeleton, { encoding: "utf8", flag: "wx" });
  await writeFile(join(moduleRoot, "log.md"), LOG_SEED, { encoding: "utf8", flag: "wx" });
}

// Markdown links [text](target); the negative lookbehind skips images ![alt](src).
const LINK_RE = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;

/** Resolve a markdown link target to a module-relative POSIX path, or undefined if not an in-module .md link. */
function resolveLink(fromRel: string, target: string): string | undefined {
  const t = target.split("#")[0]!.split("?")[0]!.trim();
  if (!t) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return undefined; // scheme (http:, mailto:, …) → external
  if (!t.endsWith(".md")) return undefined;
  const resolved = t.startsWith("/")
    ? t.slice(1)
    : posix.normalize(posix.join(posix.dirname(fromRel), t));
  if (resolved.startsWith("..")) return undefined; // escapes the module → not our concern
  return resolved.replace(/^\.\//, "");
}

async function health(moduleRoot: string): Promise<WikiHealth> {
  const pages = await walkFiles(moduleRoot, (n) => n.endsWith(".md"));
  const existing = new Set(pages);
  const concepts = pages.filter((p) => !OKF_RESERVED.has(basename(p)));

  const inbound = new Map<string, number>();
  for (const c of concepts) inbound.set(c, 0);

  const danglingLinks: Array<{ from: string; to: string }> = [];
  const catalogTargets = new Set<string>();
  const missingType: string[] = [];

  for (const page of pages) {
    let text: string;
    try {
      text = await readFile(join(moduleRoot, page), "utf8");
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(text);
    const isReserved = OKF_RESERVED.has(basename(page));
    if (!isReserved && !stringField(data, "type")) missingType.push(page);

    for (const m of body.matchAll(LINK_RE)) {
      const to = resolveLink(page, m[1]!);
      if (!to) continue;
      if (!existing.has(to)) {
        danglingLinks.push({ from: page, to });
        continue;
      }
      if (basename(page) === "index.md") catalogTargets.add(to);
      else if (inbound.has(to)) inbound.set(to, inbound.get(to)! + 1);
    }
  }

  const orphans = concepts.filter((c) => (inbound.get(c) ?? 0) === 0);
  const uncataloged = concepts.filter((c) => !catalogTargets.has(c));
  return { orphans, danglingLinks, uncataloged, missingType };
}

export const llmwikiLoader: Loader = { enumerate, overview, scaffold, health };
