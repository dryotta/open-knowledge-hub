import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

/** Resolved filesystem layout for an OKH instance (controlled by OKH_HOME). */
export interface OkhPaths {
  /** Root directory (OKH_HOME), default ~/.open-knowledge-hub. */
  readonly home: string;
  /** Directory holding one git clone per git-backed container: <home>/containers. */
  readonly containersDir: string;
  /** The per-machine registry file: <home>/registry.json. */
  readonly registryFile: string;
}

const DEFAULT_DIRNAME = ".open-knowledge-hub";

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
    containersDir: join(root, "containers"),
    registryFile: join(root, "registry.json"),
  };
}

/** Absolute path to the managed clone dir for a git-backed container. */
export function containerCloneDir(paths: OkhPaths, name: string): string {
  return join(paths.containersDir, name);
}
