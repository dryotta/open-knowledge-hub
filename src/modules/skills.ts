import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter, stringField } from "../util/frontmatter.js";

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** Provenance label for inspect/debugging. */
  source: string;
  /** Absolute path to the skill's folder (holds SKILL.md and any resource files). */
  dir?: string;
}

/** Module-local skill roots scanned, in precedence order: on a name collision an
 * earlier root (native `.okh/skills`) wins over a later one (external `.claude/skills`). */
export const MODULE_SKILL_ROOTS = [".okh/skills", ".claude/skills"] as const;

/** Sentinel skill root meaning "the module folder itself" (skills live at
 * `<module>/<name>/SKILL.md`). Used for `skills`-type modules, whose primary
 * layout places each skill directly under the module root. */
export const MODULE_ROOT_SKILL_ROOT = "";

/**
 * The skill roots to scan for a module of `moduleType`. A `skills`-type module
 * additionally treats its own folder as a skill root, so a skill authored at the
 * module root (the Copilot/Claude `skills/` convention, and what the skills loader
 * enumerates) is both discoverable and runnable. The nested `.okh/skills` /
 * `.claude/skills` roots keep precedence so an explicit override still wins.
 */
export function skillRootsForType(moduleType: string): readonly string[] {
  return moduleType === "skills"
    ? [...MODULE_SKILL_ROOTS, MODULE_ROOT_SKILL_ROOT]
    : MODULE_SKILL_ROOTS;
}

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
  return { name, description: stringField(data, "description") ?? "", body: body.trim(), source, dir };
}

/** Discover module-local skills across the given skill roots inside a module.
 * Earlier roots take precedence: a skill name found in an earlier root shadows the
 * same name in a later root (e.g. `.okh/skills` over `.claude/skills`). An empty
 * root string means the module folder itself (skills at `<module>/<name>/SKILL.md`). */
export async function discoverModuleSkills(
  moduleRoot: string,
  roots: readonly string[] = MODULE_SKILL_ROOTS,
): Promise<Skill[]> {
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const base = root ? join(moduleRoot, root) : moduleRoot;
    for (const name of await subdirNames(base)) {
      const s = await readSkill(join(base, name), root || "module-root");
      if (s && !seen.has(s.name)) {
        seen.add(s.name);
        out.push(s);
      }
    }
  }
  return out;
}

/** Discover vendored skills for a built-in type from an absolute vendored dir. */
export async function discoverVendoredSkills(vendoredDir: string, source = "vendored"): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const name of await subdirNames(vendoredDir)) {
    const s = await readSkill(join(vendoredDir, name), source);
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
