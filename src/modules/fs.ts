import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Recursively list files under `dir` matching `pred`; POSIX-relative, sorted. Skips .git/.okh. */
export async function walkFiles(dir: string, pred: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];

  async function recurse(rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === ".okh") continue;
        await recurse(childRel);
      } else if (e.isFile() && pred(e.name)) {
        out.push(childRel);
      }
    }
  }

  await recurse("");
  return out.sort();
}

/** Immediate subdirectory names of `dir` (excluding dotfiles), sorted. */
export async function subdirs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/** Immediate file names of `dir` (excluding dotfiles), sorted. */
export async function shallowFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}
