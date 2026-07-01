import { z } from "zod";
import { isAbsolute, normalize } from "node:path";

/**
 * Current catalog manifest schema version. Bump when a breaking change to the
 * on-disk shape is made, and add a migration in `manifest.ts`.
 */
export const MANIFEST_VERSION = 1;

/** A pack slug: lowercase alphanumerics and single dashes, 1-64 chars. */
export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "slug must be lowercase alphanumeric words separated by single dashes",
  );

/**
 * A repo-relative subpath for subfolder packs. Rejects absolute paths and any
 * `..` traversal so a subpath can never escape the pack's clone directory.
 */
export const subpathSchema = z
  .string()
  .min(1)
  .refine((s) => !isAbsolute(s), "subpath must be relative, not absolute")
  .refine(
    (s) => {
      const norm = normalize(s).replace(/\\/g, "/");
      return norm !== ".." && !norm.startsWith("../") && !norm.split("/").includes("..");
    },
    "subpath must not contain '..' segments",
  );

/**
 * Default subfolder for a single knowledge pack within its origin repo. Packs
 * live under `knowledge/` by convention so the repo root is free for a
 * `README.md`, `LICENSE`, and other files that are not part of the OKF bundle.
 */
export const DEFAULT_PACK_SUBPATH = "knowledge";

/**
 * Resolve a caller-supplied subpath to the effective pack subpath.
 *
 * - omitted → the default `knowledge/` subfolder
 * - `.`, `./`, or `/` → the repo root (returns `undefined`; no subfolder)
 * - anything else → the given subpath (still validated by {@link subpathSchema})
 */
export function resolveSubpath(subpath?: string): string | undefined {
  if (subpath === undefined) return DEFAULT_PACK_SUBPATH;
  const trimmed = subpath.trim();
  const norm = normalize(trimmed).replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm === "" || norm === ".") return undefined;
  return trimmed;
}

/**
 * A git origin URL. Rejects the `transport::address` remote-helper syntax (e.g.
 * `ext::sh -c ...`) which git executes as a command — a code-execution vector.
 * Normal `scheme://` URLs and scp-style `git@host:path` remain valid.
 */
export const repoUrlSchema = z
  .string()
  .min(1)
  .refine(
    (s) => !/^[A-Za-z0-9][A-Za-z0-9+.-]*::/.test(s),
    "refusing a git remote-helper URL (e.g. 'ext::'); use https://, ssh://, git@host:path or file://",
  );

/** Install lifecycle state of a catalog entry. */
export const packStateSchema = z.enum(["registered", "installed"]);
export type PackState = z.infer<typeof packStateSchema>;

/**
 * A single catalog entry: a pack's identity plus its install state.
 *
 * `subpath` is set only for subfolder packs (the pack root is `<clone>/<subpath>`).
 * `ref` pins a branch/tag; when absent the origin's default branch is used.
 * `localPath` is the absolute path to the pack root once installed.
 */
export const packEntrySchema = z
  .object({
    slug: slugSchema,
    repoUrl: repoUrlSchema,
    subpath: subpathSchema.optional(),
    ref: z.string().min(1).optional(),
    state: packStateSchema,
    localPath: z.string().min(1).optional(),
    addedAt: z.string().datetime(),
    installedAt: z.string().datetime().optional(),
  })
  .strict();
export type PackEntry = z.infer<typeof packEntrySchema>;

/** The full on-disk manifest. */
export const manifestSchema = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    packs: z.array(packEntrySchema),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;

export function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, packs: [] };
}
