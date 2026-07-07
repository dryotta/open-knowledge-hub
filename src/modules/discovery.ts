import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  loadModuleManifest,
  moduleManifestExists,
  MODULE_OKH_DIR,
  type ModuleManifest,
} from "./manifest.js";
import { OkhError } from "../errors.js";

export interface DiscoveredModule {
  /** Module path relative to the container root (POSIX separators). */
  path: string;
  /** Parsed manifest, or undefined if it failed to parse. */
  manifest?: ModuleManifest;
  /** Populated when the manifest is present but invalid. */
  error?: string;
}

/**
 * Scan `containerRoot` for modules. A folder is a module iff it contains
 * `.okh/module.yaml`; discovery does not descend below a found module. Skips
 * `.git`. Invalid manifests are recorded (not thrown) so one bad module does
 * not hide the rest.
 */
export async function discoverModules(containerRoot: string): Promise<DiscoveredModule[]> {
  const out: DiscoveredModule[] = [];

  async function recurse(rel: string): Promise<void> {
    const abs = rel ? join(containerRoot, rel) : containerRoot;
    if (rel && (await moduleManifestExists(abs))) {
      try {
        out.push({ path: rel, manifest: await loadModuleManifest(abs) });
      } catch (err) {
        out.push({ path: rel, error: err instanceof OkhError ? err.message : String(err) });
      }
      return; // do not descend into a discovered module
    }
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === ".git" || e.name === MODULE_OKH_DIR) continue;
      await recurse(rel ? `${rel}/${e.name}` : e.name);
    }
  }

  await recurse("");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
