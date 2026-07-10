import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { parseFrontmatter, stringField } from "../../util/frontmatter.js";
import { walkFiles } from "../fs.js";
import type { Item } from "../types.js";

/** OKF reserved filenames — never concept documents. */
export const OKF_RESERVED = new Set(["index.md", "log.md"]);

/** Enumerate OKF concept docs under a module root (skips reserved files). */
export async function okfEnumerate(moduleRoot: string, defaultType = "concept"): Promise<Item[]> {
  const files = await walkFiles(moduleRoot, (n) => n.endsWith(".md"));
  const items: Item[] = [];

  for (const rel of files) {
    if (OKF_RESERVED.has(basename(rel))) continue;

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
      type: stringField(data, "type") ?? defaultType,
    });
  }

  return items;
}
