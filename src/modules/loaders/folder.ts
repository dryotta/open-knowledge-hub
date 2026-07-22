import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Item, Loader } from "../types.js";

// Starter AGENTS.md written into a new folder module; resolves from src (tsx) and dist (built).
const AGENTS_SKELETON_URL = new URL(
  "../../../resources/module-types/folder/AGENTS-skeleton.md",
  import.meta.url,
);

// Top-level entries never surfaced as work items: the entry-point file, the reserved
// skill/config roots, and common build/dependency noise.
const EXCLUDED_ENTRIES = new Set([
  "AGENTS.md",
  ".okh",
  ".agents",
  ".claude",
  ".github",
  "node_modules",
  "__pycache__",
  "vendor",
  "venv",
]);

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function enumerate(moduleRoot: string): Promise<Item[]> {
  let entries;
  try {
    entries = await readdir(moduleRoot, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const items: Item[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || EXCLUDED_ENTRIES.has(entry.name)) continue;
    if (entry.isDirectory()) {
      items.push({ path: entry.name, title: entry.name, description: "", type: "folder" });
    } else if (entry.isFile()) {
      items.push({ path: entry.name, title: entry.name, description: "", type: "file" });
    }
  }
  return items;
}

async function overview(moduleRoot: string): Promise<string> {
  try {
    return await readFile(join(moduleRoot, "AGENTS.md"), "utf8");
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  return "# Folder\n\n_No AGENTS.md yet. Run the initialize skill to author one._\n";
}

async function scaffold(moduleRoot: string): Promise<void> {
  await mkdir(join(moduleRoot, ".agents", "skills"), { recursive: true });
  const skeleton = await readFile(fileURLToPath(AGENTS_SKELETON_URL), "utf8");
  await writeFile(join(moduleRoot, "AGENTS.md"), skeleton, { encoding: "utf8", flag: "wx" });
}

export const folderLoader: Loader = {
  enumerate,
  overview,
  requiredFiles: [],
  scaffold,
};
