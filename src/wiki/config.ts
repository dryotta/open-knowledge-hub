import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type WikiConfig = { title?: string; footer?: string };

const unquote = (v: string): string => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
};

export function parseWikiConfig(text: string): WikiConfig {
  const cfg: WikiConfig = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    const key = m[1];
    const value = unquote(m[2]);
    if (!value) continue;
    if (key === "title") cfg.title = value;
    else if (key === "footer") cfg.footer = value;
  }
  return cfg;
}

export async function loadWikiConfig(repoRoot: string): Promise<WikiConfig> {
  try {
    const text = await readFile(join(repoRoot, ".okh", "wiki.yml"), "utf8");
    return parseWikiConfig(text);
  } catch {
    return {};
  }
}
