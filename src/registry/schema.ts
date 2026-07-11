import { z } from "zod";

/** Registry schema version. Bump + migrate on breaking on-disk changes. */
export const REGISTRY_VERSION = 2;

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

export const backendTypeSchema = z.enum(["git", "local", "onedrive"]);
export type BackendType = z.infer<typeof backendTypeSchema>;
/** Alias kept for callers that reference the flat backend type name. */
export type Backend = BackendType;

export const syncModeSchema = z.enum(["auto", "shared"]);
export type SyncMode = z.infer<typeof syncModeSchema>;

const configSchema = z.record(z.string(), z.unknown());

export const backendDescriptorSchema = z
  .object({ type: backendTypeSchema, config: configSchema.default({}) })
  .strict();
export type BackendDescriptor = z.infer<typeof backendDescriptorSchema>;

export const syncDescriptorSchema = z
  .object({ mode: syncModeSchema.default("auto"), config: configSchema.default({}) })
  .strict();
export type SyncDescriptor = z.infer<typeof syncDescriptorSchema>;

/**
 * A registered container (v2). `backend.config.origin` holds the clone URL
 * for git backends. `localPath` is the absolute path to the container root on
 * disk.
 */
export const containerEntrySchema = z
  .object({
    name: containerNameSchema,
    backend: backendDescriptorSchema,
    localPath: z.string().min(1),
    sync: syncDescriptorSchema.default({ mode: "auto", config: {} }),
    addedAt: z.string().datetime(),
  })
  .strict();
export type ContainerEntry = z.infer<typeof containerEntrySchema>;

export const registrySchema = z
  .object({
    version: z.literal(REGISTRY_VERSION),
    containers: z.array(containerEntrySchema),
  })
  .strict();
export type Registry = z.infer<typeof registrySchema>;

/** Strict v1 schema used only for detecting and migrating legacy registry files. */
export const legacyRegistrySchema = z
  .object({
    version: z.literal(1),
    containers: z.array(
      z
        .object({
          name: containerNameSchema,
          backend: backendTypeSchema,
          origin: repoUrlSchema.optional(),
          localPath: z.string().min(1),
          sync: z.enum(["auto", "pr"]).default("auto"),
          addedAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();

export function emptyRegistry(): Registry {
  return { version: REGISTRY_VERSION, containers: [] };
}
