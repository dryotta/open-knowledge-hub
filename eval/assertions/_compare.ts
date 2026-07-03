import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** Read a directory tree into a map of POSIX-relative path -> file contents. Skips .git/.okh. */
export async function readTree(dir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
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
      } else if (e.isFile()) {
        map.set(relative(dir, p).replace(/\\/g, "/"), await readFile(p, "utf8"));
      }
    }
  }
  await rec(dir);
  return map;
}

export interface TreeDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Compare two trees (from readTree) by path + content. */
export function diffTrees(before: Map<string, string>, after: Map<string, string>): TreeDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [k, v] of after) {
    if (!before.has(k)) added.push(k);
    else if (before.get(k) !== v) changed.push(k);
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
