import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, stringField } from "../../util/frontmatter.js";
import { walkFiles } from "../fs.js";
import type { Item, Loader } from "../types.js";

const RESERVED = new Set(["index.md", "log.md"]);

// The starter index.md written into a new knowledge module. Authored as an
// editable resource; resolves from src (tsx) and dist (built).
const INDEX_SKELETON_URL = new URL("../../../resources/module-types/knowledge/index-skeleton.md", import.meta.url);

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function enumerate(moduleRoot: string): Promise<Item[]> {
  const files = await walkFiles(moduleRoot, (n) => n.endsWith(".md"));
  const items: Item[] = [];

  for (const rel of files) {
    if (RESERVED.has(basename(rel))) continue;

    let text: string;
    try {
      text = await readFile(join(moduleRoot, rel), "utf8");
    } catch {
      continue;
    }

    const { data } = parseFrontmatter(text);
    items.push({
      path: rel,
      title: stringField(data, "title") ?? basename(rel, ".md"),
      description: stringField(data, "description") ?? "",
      type: stringField(data, "type") ?? "concept",
    });
  }

  return items;
}

async function overview(moduleRoot: string): Promise<string> {
  try {
    return await readFile(join(moduleRoot, "index.md"), "utf8");
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  const items = await enumerate(moduleRoot);
  if (items.length === 0) return "# Knowledge\n\n_Empty module (no index.md, no concepts)._\n";
  const lines = items.map((i) => `* ${i.title}${i.description ? ` — ${i.description}` : ""} (\`${i.path}\`)`);
  return `# Knowledge (generated index)\n\n${lines.join("\n")}\n`;
}

async function scaffold(moduleRoot: string): Promise<void> {
  await mkdir(moduleRoot, { recursive: true });
  const skeleton = await readFile(fileURLToPath(INDEX_SKELETON_URL), "utf8");
  await writeFile(join(moduleRoot, "index.md"), skeleton, { encoding: "utf8", flag: "wx" });
}

export const knowledgeLoader: Loader = { enumerate, overview, scaffold };
