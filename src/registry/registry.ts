import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OkhPaths } from "../config.js";
import { OkhError } from "../errors.js";
import {
  emptyRegistry,
  registrySchema,
  legacyRegistrySchema,
  type Registry,
  type ContainerEntry,
} from "./schema.js";
import { migrateRegistryV1, type RegistryMigrationOptions } from "./migrate.js";

async function readRegistryJson(paths: OkhPaths): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(paths.registryFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new OkhError(
      "INVALID_MANIFEST",
      `Registry at ${paths.registryFile} is not valid JSON.`,
      "Fix or delete the file to reset the registry.",
    );
  }
}

async function parseRegistry(
  paths: OkhPaths,
  parsed: unknown,
  options: RegistryMigrationOptions,
): Promise<{ registry: Registry; migrated: boolean }> {
  const current = registrySchema.safeParse(parsed);
  if (current.success) return { registry: current.data, migrated: false };

  const legacy = legacyRegistrySchema.safeParse(parsed);
  if (legacy.success) {
    const migrated = await migrateRegistryV1(legacy.data, options);
    return { registry: migrated, migrated: true };
  }

  throw new OkhError(
    "INVALID_MANIFEST",
    `Registry at ${paths.registryFile} does not match the expected schema: ${current.error.message}`,
    "Fix or delete the file to reset the registry.",
  );
}

/** Read the registry. Missing file => empty; v1 file => migrate+save; invalid => hard error. */
export async function loadRegistry(
  paths: OkhPaths,
  options: RegistryMigrationOptions = {},
): Promise<Registry> {
  const parsed = await readRegistryJson(paths);
  if (parsed === undefined) return emptyRegistry();
  const result = await parseRegistry(paths, parsed, options);
  if (result.migrated) await saveRegistry(paths, result.registry);
  return result.registry;
}

/**
 * Read a registry snapshot without writes or external identity lookup.
 * Legacy auto-sync entries migrate in memory; legacy PR entries return the
 * existing migration error instead of consulting GitHub or persisting state.
 */
export async function loadRegistryReadOnly(paths: OkhPaths): Promise<Registry> {
  const parsed = await readRegistryJson(paths);
  if (parsed === undefined) return emptyRegistry();
  return (await parseRegistry(paths, parsed, {})).registry;
}

/**
 * Returns true iff `rawContentOrReadError` is a string that contains a valid
 * registry deeply equal to `intended`.  Returns false if it is an Error (read
 * failed), unparseable JSON, fails schema validation, or differs from
 * `intended`.  Used to decide whether an EPERM on rename represents a harmless
 * concurrent write of the same data.
 *
 * @internal Exported for unit testing only.
 */
export function epermDestinationMatchesIntended(
  intended: Registry,
  rawContentOrReadError: string | Error,
): boolean {
  if (rawContentOrReadError instanceof Error) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContentOrReadError);
  } catch {
    return false;
  }
  const result = registrySchema.safeParse(parsed);
  if (!result.success) return false;
  return isDeepStrictEqual(intended, result.data);
}

/** Persist atomically (temp file + rename). Validates before writing. */
export async function saveRegistry(paths: OkhPaths, registry: Registry): Promise<void> {
  const validated = registrySchema.parse(registry);
  await mkdir(dirname(paths.registryFile), { recursive: true });
  const tmp = `${paths.registryFile}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  try {
    await rename(tmp, paths.registryFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      // On Windows a concurrent save may have already committed the same data.
      // Read back the destination and verify it is deeply equal to what we
      // intended to write.  Accept only if identical; propagate the original
      // error for absent, invalid, or different destinations.
      let rawOrError: string | Error;
      try {
        rawOrError = await readFile(paths.registryFile, "utf8");
      } catch (readErr) {
        rawOrError = readErr as Error;
      }
      const matched = epermDestinationMatchesIntended(validated, rawOrError);
      // Best-effort cleanup in both paths; never swallow the original error.
      await unlink(tmp).catch(() => undefined);
      if (matched) return;
      throw err;
    }
    throw err;
  }
}

export function findContainer(reg: Registry, name: string): ContainerEntry | undefined {
  return reg.containers.find((c) => c.name === name);
}

export function requireContainer(reg: Registry, name: string): ContainerEntry {
  const entry = findContainer(reg, name);
  if (!entry) throw new OkhError("NOT_FOUND", `No container named "${name}" in the registry.`);
  return entry;
}

export function withContainerAdded(reg: Registry, entry: ContainerEntry): Registry {
  if (findContainer(reg, entry.name)) {
    throw new OkhError("ALREADY_EXISTS", `A container named "${entry.name}" already exists.`);
  }
  return { ...reg, containers: [...reg.containers, entry] };
}

export function withContainerUpdated(
  reg: Registry,
  name: string,
  update: (entry: ContainerEntry) => ContainerEntry,
): Registry {
  let found = false;
  const containers = reg.containers.map((c) => {
    if (c.name !== name) return c;
    found = true;
    return update(c);
  });
  if (!found) throw new OkhError("NOT_FOUND", `No container named "${name}" in the registry.`);
  return { ...reg, containers };
}

export function withContainerRemoved(reg: Registry, name: string): Registry {
  if (!findContainer(reg, name)) {
    throw new OkhError("NOT_FOUND", `No container named "${name}" in the registry.`);
  }
  return { ...reg, containers: reg.containers.filter((c) => c.name !== name) };
}
