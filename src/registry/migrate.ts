import { OkhError } from "../errors.js";
import type { z } from "zod";
import { legacyRegistrySchema, registrySchema, REGISTRY_VERSION, type Registry } from "./schema.js";

export interface RegistryMigrationOptions {
  resolveGitLogin?: () => Promise<string>;
}

type LegacyRegistry = z.infer<typeof legacyRegistrySchema>;

export async function migrateRegistryV1(
  legacy: LegacyRegistry,
  options: RegistryMigrationOptions = {},
): Promise<Registry> {
  const containers: Registry["containers"] = [];
  for (const entry of legacy.containers) {
    if (entry.backend === "git" && !entry.origin) {
      throw new OkhError(
        "INVALID_MANIFEST",
        `Legacy Git container "${entry.name}" has no origin.`,
      );
    }
    let sync: Registry["containers"][number]["sync"];
    if (entry.backend === "git" && entry.sync === "pr") {
      if (!options.resolveGitLogin) {
        throw new OkhError(
          "INVALID_MANIFEST",
          `Legacy PR container "${entry.name}" needs a GitHub login to migrate.`,
          "Authenticate with `gh auth login` and retry.",
        );
      }
      let login: string;
      try {
        login = await options.resolveGitLogin();
      } catch (error) {
        throw new OkhError(
          "INVALID_MANIFEST",
          `Could not migrate legacy PR container "${entry.name}": ${(error as Error).message}`,
          "Authenticate with `gh auth login` and retry.",
        );
      }
      sync = { mode: "shared", config: { branch: `user/${login}/hub` } };
    } else {
      sync = { mode: "auto", config: {} };
    }
    containers.push({
      name: entry.name,
      backend: {
        type: entry.backend,
        config: entry.backend === "git" ? { origin: entry.origin! } : {},
      },
      localPath: entry.localPath,
      sync,
      addedAt: entry.addedAt,
    });
  }
  const migrated = { version: REGISTRY_VERSION, containers };
  return registrySchema.parse(migrated);
}
