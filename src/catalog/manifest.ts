import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { OkhPaths } from "../config.js";
import { OkhError } from "../errors.js";
import {
  emptyManifest,
  manifestSchema,
  type Manifest,
  type PackEntry,
} from "./schema.js";

/**
 * Read the catalog manifest from disk.
 *
 * A missing file is treated as an empty catalog (first run). A present-but-invalid
 * file is a hard error — we never silently discard a user's catalog.
 */
export async function loadManifest(paths: OkhPaths): Promise<Manifest> {
  let raw: string;
  try {
    raw = await readFile(paths.manifestFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyManifest();
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OkhError(
      "INVALID_MANIFEST",
      `Catalog manifest at ${paths.manifestFile} is not valid JSON.`,
      "Fix or delete the file to reset the catalog.",
    );
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new OkhError(
      "INVALID_MANIFEST",
      `Catalog manifest at ${paths.manifestFile} does not match the expected schema: ${result.error.message}`,
      "Fix or delete the file to reset the catalog.",
    );
  }
  return result.data;
}

/**
 * Persist the manifest atomically (write to a temp file, then rename) so a crash
 * mid-write can never corrupt an existing catalog.
 */
export async function saveManifest(paths: OkhPaths, manifest: Manifest): Promise<void> {
  const validated = manifestSchema.parse(manifest);
  await mkdir(dirname(paths.manifestFile), { recursive: true });
  const tmp = `${paths.manifestFile}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  await rename(tmp, paths.manifestFile);
}

/** Find a pack entry by slug, or return undefined. */
export function findPack(manifest: Manifest, slug: string): PackEntry | undefined {
  return manifest.packs.find((p) => p.slug === slug);
}

/** Find a pack entry by slug, or throw NOT_FOUND. */
export function requirePack(manifest: Manifest, slug: string): PackEntry {
  const entry = findPack(manifest, slug);
  if (!entry) {
    throw new OkhError("NOT_FOUND", `No pack named "${slug}" in the catalog.`);
  }
  return entry;
}

/** Return a new manifest with `entry` added (throws if the slug already exists). */
export function withPackAdded(manifest: Manifest, entry: PackEntry): Manifest {
  if (findPack(manifest, entry.slug)) {
    throw new OkhError("ALREADY_EXISTS", `A pack named "${entry.slug}" already exists.`);
  }
  return { ...manifest, packs: [...manifest.packs, entry] };
}

/** Return a new manifest with the entry for `slug` replaced. */
export function withPackUpdated(
  manifest: Manifest,
  slug: string,
  update: (entry: PackEntry) => PackEntry,
): Manifest {
  let found = false;
  const packs = manifest.packs.map((p) => {
    if (p.slug !== slug) return p;
    found = true;
    return update(p);
  });
  if (!found) {
    throw new OkhError("NOT_FOUND", `No pack named "${slug}" in the catalog.`);
  }
  return { ...manifest, packs };
}

/** Return a new manifest with the entry for `slug` removed (throws if absent). */
export function withPackRemoved(manifest: Manifest, slug: string): Manifest {
  if (!findPack(manifest, slug)) {
    throw new OkhError("NOT_FOUND", `No pack named "${slug}" in the catalog.`);
  }
  return { ...manifest, packs: manifest.packs.filter((p) => p.slug !== slug) };
}
