import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { OkhPaths } from "../config.js";
import { OkhError } from "../errors.js";
import {
  emptyRegistry,
  registrySchema,
  type Registry,
  type ContainerEntry,
} from "./schema.js";

/** Read the registry. Missing file => empty; present-but-invalid => hard error. */
export async function loadRegistry(paths: OkhPaths): Promise<Registry> {
  let raw: string;
  try {
    raw = await readFile(paths.registryFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OkhError(
      "INVALID_MANIFEST",
      `Registry at ${paths.registryFile} is not valid JSON.`,
      "Fix or delete the file to reset the registry.",
    );
  }
  const result = registrySchema.safeParse(parsed);
  if (!result.success) {
    throw new OkhError(
      "INVALID_MANIFEST",
      `Registry at ${paths.registryFile} does not match the expected schema: ${result.error.message}`,
      "Fix or delete the file to reset the registry.",
    );
  }
  return result.data;
}

/** Persist atomically (temp file + rename). Validates before writing. */
export async function saveRegistry(paths: OkhPaths, registry: Registry): Promise<void> {
  const validated = registrySchema.parse(registry);
  await mkdir(dirname(paths.registryFile), { recursive: true });
  const tmp = `${paths.registryFile}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  await rename(tmp, paths.registryFile);
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
