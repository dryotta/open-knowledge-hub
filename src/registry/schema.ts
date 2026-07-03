import { z } from "zod";

/** Registry schema version. Bump + migrate on breaking on-disk changes. */
export const REGISTRY_VERSION = 1;

/** A container name: lowercase alphanumerics and single dashes, 1-64 chars. */
export const containerNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "name must be lowercase alphanumeric words separated by single dashes",
  );

/**
 * A git origin URL. Rejects the `transport::address` remote-helper syntax
 * (e.g. `ext::sh -c ...`) which git executes as a command. Normal `scheme://`
 * URLs and scp-style `git@host:path` remain valid.
 */
export const repoUrlSchema = z
  .string()
  .min(1)
  .refine(
    (s) => !/^[A-Za-z0-9][A-Za-z0-9+.-]*::/.test(s),
    "refusing a git remote-helper URL (e.g. 'ext::'); use https://, ssh://, git@host:path or file://",
  );

export const backendSchema = z.enum(["git", "local", "onedrive"]);
export type Backend = z.infer<typeof backendSchema>;

/**
 * A registered container. `origin` is required for git backends (the clone
 * source) and absent otherwise. `localPath` is the absolute path to the
 * container root on disk (the managed clone dir for git, the in-place folder
 * for local/onedrive).
 */
export const containerEntrySchema = z
  .object({
    name: containerNameSchema,
    backend: backendSchema,
    origin: repoUrlSchema.optional(),
    localPath: z.string().min(1),
    addedAt: z.string().datetime(),
  })
  .strict()
  .refine((e) => e.backend !== "git" || !!e.origin, {
    message: "git containers must record an origin",
    path: ["origin"],
  });
export type ContainerEntry = z.infer<typeof containerEntrySchema>;

export const registrySchema = z
  .object({
    version: z.literal(REGISTRY_VERSION),
    containers: z.array(containerEntrySchema),
  })
  .strict();
export type Registry = z.infer<typeof registrySchema>;

export function emptyRegistry(): Registry {
  return { version: REGISTRY_VERSION, containers: [] };
}
