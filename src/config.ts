import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

/**
 * Resolved filesystem layout for an open-knowledge-hub instance.
 *
 * `home` is the root; everything else lives underneath it. The location is
 * controlled by the `OKH_HOME` environment variable and defaults to
 * `~/.open-knowledge-hub`.
 */
export interface OkhPaths {
  /** Root directory (OKH_HOME). */
  readonly home: string;
  /** Directory holding one git clone per installed pack: `<home>/packs`. */
  readonly packsDir: string;
  /** The catalog manifest file: `<home>/catalog.json`. */
  readonly manifestFile: string;
}

const DEFAULT_DIRNAME = ".open-knowledge-hub";

/**
 * Resolve the OKH filesystem layout from the environment.
 *
 * @param env Environment to read `OKH_HOME` from (defaults to `process.env`).
 * @param home User home directory (injectable for tests; defaults to `os.homedir()`).
 */
export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): OkhPaths {
  const configured = env.OKH_HOME?.trim();
  const root = configured
    ? isAbsolute(configured)
      ? configured
      : join(process.cwd(), configured)
    : join(home, DEFAULT_DIRNAME);

  return {
    home: root,
    packsDir: join(root, "packs"),
    manifestFile: join(root, "catalog.json"),
  };
}

/** Absolute path to the local clone directory for a pack slug. */
export function packCloneDir(paths: OkhPaths, slug: string): string {
  return join(paths.packsDir, slug);
}
