import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname, isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { OkhError } from "../errors.js";
import { moduleTypeSchema } from "../modules/types.js";

export const OKH_DIR = ".okh";
export const MANIFEST_BASENAME = "okh.yaml";

/** A container-relative module path. Rejects absolute paths, `..`, and `.okh`. */
export const modulePathSchema = z
  .string()
  .min(1)
  .refine((s) => !isAbsolute(s), "module path must be relative")
  .refine((s) => {
    const norm = normalize(s).replace(/\\/g, "/");
    return norm !== ".." && !norm.startsWith("../") && !norm.split("/").includes("..");
  }, "module path must not contain '..' segments")
  .refine(
    (s) => normalize(s).replace(/\\/g, "/").split("/")[0] !== OKH_DIR,
    "module path must not live inside .okh",
  );

export const syncModeSchema = z.enum(["auto", "pr"]);
export type SyncMode = z.infer<typeof syncModeSchema>;

export const moduleEntrySchema = z
  .object({
    path: modulePathSchema,
    type: moduleTypeSchema,
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ModuleEntry = z.infer<typeof moduleEntrySchema>;

export const containerManifestSchema = z
  .object({
    name: z.string().min(1),
    sync: syncModeSchema.default("auto"),
    modules: z.array(moduleEntrySchema).default([]),
  })
  .strict();
export type ContainerManifest = z.infer<typeof containerManifestSchema>;

export function manifestPath(containerRoot: string): string {
  return join(containerRoot, OKH_DIR, MANIFEST_BASENAME);
}

export async function manifestExists(containerRoot: string): Promise<boolean> {
  try {
    await stat(manifestPath(containerRoot));
    return true;
  } catch {
    return false;
  }
}

/** Read + validate the manifest. Missing file => INVALID_MANIFEST. */
export async function loadContainerManifest(containerRoot: string): Promise<ContainerManifest> {
  const file = manifestPath(containerRoot);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OkhError(
        "INVALID_MANIFEST",
        `Container at ${containerRoot} has no ${OKH_DIR}/${MANIFEST_BASENAME}.`,
        "Run the add tool to register it and scaffold a manifest.",
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
  const result = containerManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new OkhError(
      "INVALID_MANIFEST",
      `${file} does not match the expected schema: ${result.error.message}`,
    );
  }
  return result.data;
}

/** Serialize + write the manifest to `.okh/okh.yaml`. */
export async function saveContainerManifest(
  containerRoot: string,
  manifest: ContainerManifest,
): Promise<void> {
  const validated = containerManifestSchema.parse(manifest);
  const file = manifestPath(containerRoot);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(validated), "utf8");
}

export function scaffoldManifest(name: string): ContainerManifest {
  return { name, sync: "auto", modules: [] };
}
