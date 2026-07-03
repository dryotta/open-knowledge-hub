import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter, stringField } from "../../util/frontmatter.js";
import { subdirs } from "../fs.js";
import type { Item, Loader } from "../types.js";

async function enumerate(moduleRoot: string): Promise<Item[]> {
  const dirs = await subdirs(moduleRoot);
  const items: Item[] = [];

  for (const dir of dirs) {
    let text: string;
    try {
      text = await readFile(join(moduleRoot, dir, "SKILL.md"), "utf8");
    } catch {
      continue;
    }

    const { data } = parseFrontmatter(text);
    items.push({
      path: `${dir}/SKILL.md`,
      title: stringField(data, "name") ?? dir,
      description: stringField(data, "description") ?? "",
      type: "skill",
    });
  }

  return items;
}

async function overview(moduleRoot: string): Promise<string> {
  const items = await enumerate(moduleRoot);
  if (items.length === 0) {
    return "# Skills\n\n_No skills found (each skill is a folder with a SKILL.md)._\n";
  }
  const lines = items.map(
    (i) => `* **${i.title}**${i.description ? ` — ${i.description}` : ""} (\`${i.path}\`)`,
  );
  return `# Skills\n\n${lines.join("\n")}\n`;
}

export const skillsLoader: Loader = { enumerate, overview };
