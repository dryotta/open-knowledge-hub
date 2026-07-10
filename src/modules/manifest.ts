import { mkdir, readFile, writeFile, stat, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { OkhError } from "../errors.js";

export const MODULE_OKH_DIR = ".okh";
export const MODULE_MANIFEST_BASENAME = "module.yaml";

export const moduleManifestSchema = z
  .object({
    type: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(""),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

export function moduleManifestPath(moduleRoot: string): string {
  return join(moduleRoot, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME);
}

export async function moduleManifestExists(moduleRoot: string): Promise<boolean> {
  try {
    await stat(moduleManifestPath(moduleRoot));
    return true;
  } catch {
    return false;
  }
}

/** Read + validate a module's `.okh/module.yaml`. Missing file => INVALID_MANIFEST. */
export async function loadModuleManifest(moduleRoot: string): Promise<ModuleManifest> {
  const file = moduleManifestPath(moduleRoot);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OkhError(
        "INVALID_MANIFEST",
        `Module at ${moduleRoot} has no ${MODULE_OKH_DIR}/${MODULE_MANIFEST_BASENAME}.`,
        "Run the add_module tool to scaffold the module, or create the manifest by hand.",
      );
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    throw new OkhError("INVALID_MANIFEST", `${file} is not valid YAML.`);
  }
  const result = moduleManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new OkhError("INVALID_MANIFEST", `${file} does not match the expected schema: ${result.error.message}`);
  }
  return result.data;
}

/** Serialize + write the manifest atomically to `<moduleRoot>/.okh/module.yaml`. */
export async function saveModuleManifest(moduleRoot: string, manifest: ModuleManifest): Promise<void> {
  const validated = moduleManifestSchema.parse(manifest);
  const file = moduleManifestPath(moduleRoot);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, stringifyYaml(validated), "utf8");
  await rename(tmp, file);
}

/** Build a minimal in-memory manifest (no config). */
export function scaffoldModuleManifest(type: string, name: string, description: string): ModuleManifest {
  return { type, name, description };
}
