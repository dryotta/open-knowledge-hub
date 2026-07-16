import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { walkFiles } from "../fs.js";
import type { Item, Loader } from "../types.js";

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** A minimal loader for TBD-format modules: lists files recursively, README as overview header. */
export function fileListingLoader(kind: string, heading: string): Loader {
  async function enumerate(moduleRoot: string): Promise<Item[]> {
    const ignoredDirectories = new Set(["node_modules", "__pycache__", "vendor", "venv"]);
    const files = await walkFiles(
      moduleRoot,
      (name) => !name.startsWith("."),
      (name) => !name.startsWith(".") && !ignoredDirectories.has(name),
    );
    return files
      .filter((f) => f !== "README.md")
      .map((f) => ({ path: f, title: f, description: "", type: kind }));
  }

  async function overview(moduleRoot: string): Promise<string> {
    let readme = "";
    try {
      readme = (await readFile(join(moduleRoot, "README.md"), "utf8")).trim();
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    const items = await enumerate(moduleRoot);
    const list = items.length ? items.map((i) => `* \`${i.path}\``).join("\n") : "_Empty._";
    const head = readme ? `${readme}\n\n` : "";
    return `${head}# ${heading}\n\n${list}\n`;
  }

  return { enumerate, overview };
}
