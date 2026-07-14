import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { discoverVendoredSkills, type Skill } from "./skills.js";
import { OkhError } from "../errors.js";

// resources/ sits at the package root; ../../ resolves there from src (tsx) and dist (built).
const SHARED_ROOT = new URL("../../resources/shared/skills/", import.meta.url);

/** List the bundled shared skills (runnable module-less via the run tool). */
export async function sharedSkills(): Promise<Skill[]> {
  return discoverVendoredSkills(fileURLToPath(SHARED_ROOT), "shared");
}

/** Resolve one shared skill by name; throws NOT_FOUND listing available shared skills. */
export async function resolveSharedSkill(name: string): Promise<Skill> {
  const skills = await sharedSkills();
  const found = skills.find((s) => s.name === name);
  if (!found) {
    const names = skills.map((s) => s.name).join(", ") || "(none)";
    throw new OkhError("NOT_FOUND", `No shared skill "${name}". Available: ${names}.`);
  }
  return found;
}

/** Subfolders never surfaced as skill resources (VCS/build/cache noise). */
const RESOURCE_SKIP_DIRS = new Set(["node_modules", "__pycache__", ".venv"]);

/** Absolute paths of a skill's bundled resource files — everything under the
 * skill folder except its top-level `SKILL.md`. Recurses into subfolders so a
 * tool-skill that bundles its CLI as a package (e.g. `lib/*.py`) has every file
 * reachable; only paths are returned, so the details load only when the agent
 * opens one. Dotfiles/dot-dirs and common noise dirs are skipped. */
export async function skillResourcePaths(skill: Skill): Promise<string[]> {
  const rootDir = skill.dir;
  if (!rootDir) return [];
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (RESOURCE_SKIP_DIRS.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile()) {
        if (dir === rootDir && e.name === "SKILL.md") continue;
        out.push(full);
      }
    }
  }

  await walk(rootDir);
  return out.sort();
}
