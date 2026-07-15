import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { okfEnumerate } from "./okf.js";
import type { Item, Loader } from "../types.js";

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
  return okfEnumerate(moduleRoot, "concept");
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

export const knowledgeLoader: Loader = {
  enumerate,
  overview,
  requiredFiles: ["index.md"],
  scaffold,
};
