import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter, stringField } from "../util/frontmatter.js";

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** Provenance label for inspect/debugging. */
  source: string;
}

/** Module-local skill roots scanned, in precedence order (later roots do not override earlier by design; merge handles override). */
export const MODULE_SKILL_ROOTS = [".okh/skills", ".claude/skills"] as const;

async function subdirNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Read one `<dir>/SKILL.md` into a Skill, or undefined if absent/unnamed. */
export async function readSkill(dir: string, source: string): Promise<Skill | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
  const { data, body } = parseFrontmatter(text);
  const name = stringField(data, "name");
  if (!name) return undefined;
  return { name, description: stringField(data, "description") ?? "", body: body.trim(), source };
}

/** Discover module-local skills across all known skill roots inside a module. */
export async function discoverModuleSkills(moduleRoot: string): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const root of MODULE_SKILL_ROOTS) {
    const base = join(moduleRoot, root);
    for (const name of await subdirNames(base)) {
      const s = await readSkill(join(base, name), root);
      if (s) out.push(s);
    }
  }
  return out;
}

/** Discover vendored skills for a built-in type from an absolute vendored dir. */
export async function discoverVendoredSkills(vendoredDir: string): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const name of await subdirNames(vendoredDir)) {
    const s = await readSkill(join(vendoredDir, name), "vendored");
    if (s) out.push(s);
  }
  return out;
}

/** Merge vendored ∪ local; a local skill overrides a vendored one of the same name. */
export function mergeSkills(vendored: Skill[], local: Skill[]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of vendored) byName.set(s.name, s);
  for (const s of local) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
