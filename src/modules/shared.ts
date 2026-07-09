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

/** Absolute paths of a skill's sibling resource files (everything but SKILL.md). */
export async function skillResourcePaths(skill: Skill): Promise<string[]> {
  if (!skill.dir) return [];
  const entries = await readdir(skill.dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name !== "SKILL.md")
    .map((e) => join(skill.dir!, e.name))
    .sort();
}
