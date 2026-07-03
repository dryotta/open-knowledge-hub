import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { subdirs } from "../fs.js";
import type { Item, Loader } from "../types.js";

/** Title = first `# heading`; description = first non-empty non-heading line. */
function titleAndDesc(readme: string, fallback: string): { title: string; description: string } {
  let title = fallback;
  let description = "";
  let sawHeading = false;

  for (const line of readme.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;

    const h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h && !sawHeading) {
      title = h[1]!.trim();
      sawHeading = true;
      continue;
    }

    if (!h) {
      description = t;
      break;
    }
  }

  return { title, description };
}

async function enumerate(moduleRoot: string): Promise<Item[]> {
  const dirs = await subdirs(moduleRoot);
  const items: Item[] = [];

  for (const dir of dirs) {
    let text: string;
    try {
      text = await readFile(join(moduleRoot, dir, "README.md"), "utf8");
    } catch {
      continue;
    }

    const { title, description } = titleAndDesc(text, dir);
    items.push({ path: `${dir}/README.md`, title, description, type: "tool" });
  }

  return items;
}

async function overview(moduleRoot: string): Promise<string> {
  const items = await enumerate(moduleRoot);
  if (items.length === 0) {
    return "# Tools\n\n_No tools found (each tool is a folder with a README.md)._\n";
  }
  const lines = items.map(
    (i) => `* **${i.title}**${i.description ? ` — ${i.description}` : ""} (\`${i.path}\`)`,
  );
  return `# Tools\n\n${lines.join("\n")}\n`;
}

export const toolsLoader: Loader = { enumerate, overview };
