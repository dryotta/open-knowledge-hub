import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanSkillsInRoot } from "../skills.js";
import type { Item, Loader } from "../types.js";

const INDEX_SKELETON_URL = new URL("../../../resources/module-types/skills/index-skeleton.md", import.meta.url);

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function enumerate(moduleRoot: string): Promise<Item[]> {
  return (await scanSkillsInRoot(moduleRoot, "module-root")).skills.map((skill) => ({
    path: skill.path!,
    title: skill.name,
    description: skill.description,
    type: "skill",
  }));
}

async function overview(moduleRoot: string): Promise<string> {
  try {
    return await readFile(join(moduleRoot, "index.md"), "utf8");
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  const items = await enumerate(moduleRoot);
  if (items.length === 0) {
    return "# Skills\n\n_Empty skills module (no index.md, no SKILL.md leaves)._\n";
  }
  const lines = items.map(
    (i) => `* **${i.title}**${i.description ? ` — ${i.description}` : ""} (\`${i.path}\`)`,
  );
  return `# Skills (generated index)\n\n${lines.join("\n")}\n`;
}

async function scaffold(moduleRoot: string): Promise<void> {
  await mkdir(moduleRoot, { recursive: true });
  const skeleton = await readFile(fileURLToPath(INDEX_SKELETON_URL), "utf8");
  await writeFile(join(moduleRoot, "index.md"), skeleton, { encoding: "utf8", flag: "wx" });
}

export const skillsLoader: Loader = {
  enumerate,
  overview,
  requiredFiles: ["index.md"],
  scaffold,
};
