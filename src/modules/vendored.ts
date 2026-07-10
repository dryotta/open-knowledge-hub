import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";
import { discoverVendoredSkills, type Skill } from "./skills.js";
import { isBuiltinType } from "./types.js";

// resources/ sits at the package root; ../../ resolves there from src (tsx) and dist (built).
const MODULE_TYPES_ROOT = new URL("../../resources/module-types/", import.meta.url);

/** Absolute path to a type's vendored skills dir, or undefined for custom types. */
export function vendoredSkillsDir(type: string): string | undefined {
  if (!isBuiltinType(type)) return undefined;
  return fileURLToPath(new URL(`${type}/skills/`, MODULE_TYPES_ROOT));
}

/** List a type's vendored skills (empty for custom types or types with no skills). */
export async function vendoredSkills(type: string): Promise<Skill[]> {
  const dir = vendoredSkillsDir(type);
  if (!dir) return [];
  if (!(await stat(dir).then((s) => s.isDirectory()).catch(() => false))) return [];
  return discoverVendoredSkills(dir);
}
