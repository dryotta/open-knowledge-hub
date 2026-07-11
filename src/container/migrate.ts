import { readFile, rm, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { saveModuleManifest, moduleManifestExists } from "../modules/manifest.js";

const LEGACY_REL = join(".okh", "okh.yaml");

const legacySyncModeEnum = z.enum(["auto", "pr"]);
export type LegacySyncMode = z.infer<typeof legacySyncModeEnum>;

const legacyContainerSchema = z.object({
  sync: legacySyncModeEnum.optional(),
  modules: z
    .array(z.object({ path: z.string(), type: z.string(), config: z.record(z.string(), z.unknown()).optional() }))
    .default([]),
});

/**
 * One-time migration: if `<root>/.okh/okh.yaml` exists, write a per-module
 * `<module>/.okh/module.yaml` for each listed module (unless one already exists),
 * delete the legacy file, and return the raw legacy sync string. Idempotent: no-op
 * when the legacy file is absent.
 */
export async function migrateLegacyContainerManifest(root: string): Promise<LegacySyncMode | undefined> {
  const legacyPath = join(root, LEGACY_REL);
  let raw: string;
  try {
    raw = await readFile(legacyPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch {
    return undefined; // leave a syntactically malformed legacy file alone
  }
  const parsed = legacyContainerSchema.safeParse(doc);
  if (!parsed.success) return undefined; // leave a schema-invalid legacy file alone
  for (const m of parsed.data.modules) {
    const moduleRoot = join(root, m.path);
    if ((await stat(moduleRoot).catch(() => null)) && !(await moduleManifestExists(moduleRoot))) {
      await saveModuleManifest(moduleRoot, {
        type: m.type,
        name: basename(m.path),
        description: "",
        ...(m.config ? { config: m.config } : {}),
      });
    }
  }
  await rm(legacyPath, { force: true });
  return parsed.data.sync;
}
