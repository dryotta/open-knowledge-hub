import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { OkhError } from "../errors.js";
import { parseFrontmatter, stringField } from "../util/frontmatter.js";

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** Provenance label for inspect/debugging. */
  source: string;
  /** Absolute path to the skill's folder (holds SKILL.md and any resource files). */
  dir?: string;
  /** POSIX path to SKILL.md, relative to the skill root represented by `source`. */
  path?: string;
  /** MCP resources that must be read when applying this skill. */
  resourceUris?: string[];
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

export interface SkillRootScan {
  skills: Skill[];
  issues: string[];
}

const SKILL_TREE_SKIP_DIRS = new Set(["node_modules", "__pycache__", ".venv"]);
const SKILL_RESOURCE_SKIP_DIRS = new Set(["node_modules", "__pycache__", ".venv"]);

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function shouldSkipDir(name: string): boolean {
  return name.startsWith(".") || SKILL_TREE_SKIP_DIRS.has(name);
}

function skillFromText(
  text: string,
  dir: string,
  source: string,
  path?: string,
): Skill | undefined {
  const { data, body } = parseFrontmatter(text);
  const name = stringField(data, "name")?.trim();
  if (!name) return undefined;
  const rawResources = data["resources"];
  let resourceUris: string[] | undefined;
  if (rawResources !== undefined) {
    if (
      !Array.isArray(rawResources)
      || rawResources.some((value) => typeof value !== "string" || value.trim().length === 0)
    ) {
      throw new OkhError(
        "INVALID_MANIFEST",
        `Skill "${name}" frontmatter resources must be an array of non-empty URI strings.`,
      );
    }
    resourceUris = rawResources.map((value) => value.trim());
    for (const uri of resourceUris) {
      try {
        new URL(uri);
      } catch {
        throw new OkhError(
          "INVALID_MANIFEST",
          `Skill "${name}" has invalid resource URI "${uri}".`,
        );
      }
    }
  }
  return {
    name,
    description: stringField(data, "description")?.trim() ?? "",
    body: body.trim(),
    source,
    dir,
    ...(path ? { path } : {}),
    ...(resourceUris?.length ? { resourceUris } : {}),
  };
}

/**
 * Scan one skill root recursively. Group directories may nest arbitrarily; the
 * first directory containing SKILL.md is a leaf, so bundled resource folders are
 * never mistaken for child skills.
 */
export async function scanSkillsInRoot(root: string, source: string): Promise<SkillRootScan> {
  const skills: Skill[] = [];
  const issues: string[] = [];

  async function walk(dir: string, rel: string, canBeSkill: boolean): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) return;
      issues.push(`${rel || "."}: cannot read directory`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const marker = entries.find((entry) => entry.name === "SKILL.md");
    if (!canBeSkill && marker) {
      issues.push("SKILL.md: a skill root cannot itself be a skill leaf; use a child folder");
    }
    if (canBeSkill) {
      if (marker) {
        const path = `${rel}/SKILL.md`;
        if (!marker.isFile()) {
          issues.push(`${path}: must be a file`);
          return;
        }
        let text: string;
        try {
          text = await readFile(join(dir, "SKILL.md"), "utf8");
        } catch {
          issues.push(`${path}: cannot read file`);
          return;
        }
        let skill: Skill | undefined;
        try {
          skill = skillFromText(text, dir, source, path);
        } catch (error) {
          issues.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (!skill) {
          issues.push(`${path}: missing non-empty frontmatter name`);
          return;
        }
        skills.push(skill);
        return;
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      await walk(join(dir, entry.name), childRel, true);
    }
  }

  await walk(root, "", false);
  skills.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""));

  const byName = new Map<string, string[]>();
  for (const skill of skills) {
    const paths = byName.get(skill.name) ?? [];
    paths.push(skill.path ?? skill.name);
    byName.set(skill.name, paths);
  }
  for (const [name, paths] of byName) {
    if (paths.length > 1) {
      issues.push(`duplicate skill name "${name}" at ${paths.join(", ")}`);
    }
  }

  return { skills, issues: issues.sort() };
}

/** Discover every valid skill in one recursive skill root. */
export async function discoverSkillsInRoot(root: string, source: string): Promise<Skill[]> {
  const scan = await scanSkillsInRoot(root, source);
  if (scan.issues.length > 0) {
    throw new OkhError(
      "INVALID_MANIFEST",
      `Invalid ${source || "module-root"} skill tree: ${scan.issues.join("; ")}.`,
    );
  }
  return scan.skills;
}

export interface ModuleSkillDiscovery {
  skills: Skill[];
  issues: string[];
}

/**
 * Discover module-local skills without disabling valid leaves when siblings are
 * malformed. Earlier roots still shadow later roots by name; duplicates within
 * one root remain visible so resolution can report an explicit conflict.
 */
export async function discoverModuleSkillSet(
  moduleRoot: string,
  roots: readonly string[] = MODULE_SKILL_ROOTS,
): Promise<ModuleSkillDiscovery> {
  const scans = await Promise.all(
    roots.map(async (root) => {
      const source = root || "module-root";
      return {
        source,
        scan: await scanSkillsInRoot(root ? join(moduleRoot, root) : moduleRoot, source),
      };
    }),
  );

  const skills: Skill[] = [];
  const issues: string[] = [];
  const seenFromEarlierRoots = new Set<string>();
  for (const { source, scan } of scans) {
    issues.push(...scan.issues.map((issue) => `${source}: ${issue}`));
    for (const skill of scan.skills) {
      if (!seenFromEarlierRoots.has(skill.name)) skills.push(skill);
    }
    for (const skill of scan.skills) seenFromEarlierRoots.add(skill.name);
  }
  return { skills, issues };
}

/** Structural issues across a module's configured skill roots. Missing optional roots are valid. */
export async function validateModuleSkills(
  moduleRoot: string,
  roots: readonly string[] = MODULE_SKILL_ROOTS,
): Promise<string[]> {
  return (await discoverModuleSkillSet(moduleRoot, roots)).issues;
}

/** Read one `<dir>/SKILL.md` into a Skill, or undefined if absent/unnamed. */
export async function readSkill(
  dir: string,
  source: string,
  path?: string,
): Promise<Skill | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
  return skillFromText(text, dir, source, path);
}

/** Discover module-local skills across the given skill roots inside a module.
 * Earlier roots take precedence: a skill name found in an earlier root shadows the
 * same name in a later root (e.g. `.okh/skills` over `.claude/skills`). An empty
 * root string means the module folder itself. Each root may contain arbitrary-depth
 * grouping folders; directories containing SKILL.md are leaf skills. */
export async function discoverModuleSkills(
  moduleRoot: string,
  roots: readonly string[] = MODULE_SKILL_ROOTS,
): Promise<Skill[]> {
  return (await discoverModuleSkillSet(moduleRoot, roots)).skills;
}

/** Discover vendored skills for a built-in type from an absolute vendored dir. */
export async function discoverVendoredSkills(vendoredDir: string, source = "vendored"): Promise<Skill[]> {
  return discoverSkillsInRoot(vendoredDir, source);
}

/** Merge vendored ∪ local; a local skill overrides a vendored one of the same name. */
export function mergeSkills(vendored: Skill[], local: Skill[]): Skill[] {
  const localNames = new Set(local.map((skill) => skill.name));
  return [...vendored.filter((skill) => !localNames.has(skill.name)), ...local].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      (a.path ?? "").localeCompare(b.path ?? "") ||
      a.source.localeCompare(b.source),
  );
}

/** Absolute paths of a skill's sibling files, excluding SKILL.md and common cache/build noise. */
export async function skillResourcePaths(skill: Skill): Promise<string[]> {
  const rootDir = skill.dir;
  if (!rootDir) return [];
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new OkhError(
          "NOT_FOUND",
          `Resources for skill "${skill.name}" are no longer available.`,
        );
      }
      if (code === "EACCES" || code === "EPERM") {
        throw new OkhError(
          "INVALID_MANIFEST",
          `Resources for skill "${skill.name}" cannot be read.`,
        );
      }
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKILL_RESOURCE_SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (dir === rootDir && entry.name === "SKILL.md") continue;
        out.push(full);
      }
    }
  }

  await walk(rootDir);
  return out.sort();
}
