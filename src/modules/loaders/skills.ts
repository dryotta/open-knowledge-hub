import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverModuleSkills, skillRootsForType } from "../skills.js";
import type { Item, Loader } from "../types.js";

// The starter index.md written into a new skills module. Authored as an editable
// resource; resolves from src (tsx) and dist (built).
const INDEX_SKELETON_URL = new URL("../../../resources/module-types/skills/index-skeleton.md", import.meta.url);

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** POSIX, module-relative path to a skill's SKILL.md (from the skill's absolute dir). */
function skillItemPath(moduleRoot: string, dir: string | undefined, name: string): string {
  if (!dir) return `${name}/SKILL.md`;
  const rel = relative(moduleRoot, dir).split(sep).join("/");
  return rel ? `${rel}/SKILL.md` : "SKILL.md";
}

async function enumerate(moduleRoot: string): Promise<Item[]> {
  const skills = await discoverModuleSkills(moduleRoot, skillRootsForType("skills"));
  return skills.map((s) => ({
    path: skillItemPath(moduleRoot, s.dir, s.name),
    title: s.name,
    description: s.description,
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
    return "# Skills\n\n_Empty module (no index.md, no skills). Each skill is a folder with a SKILL.md; group related skills under subfolders._\n";
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

export const skillsLoader: Loader = { enumerate, overview, scaffold };
