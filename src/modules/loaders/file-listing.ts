import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { shallowFiles } from "../fs.js";
import type { Item, Loader } from "../types.js";

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** A minimal loader for TBD-format modules: lists shallow files, README as overview header. */
export function fileListingLoader(kind: "memory" | "project", heading: string): Loader {
  async function enumerate(moduleRoot: string): Promise<Item[]> {
    const files = await shallowFiles(moduleRoot);
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
