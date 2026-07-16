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
 * Scan `containerRoot` for modules. A module is a **direct child folder** of the
 * container root that contains `.okh/module.yaml`. Discovery does not treat nested
 * folders as modules; a stray manifest found deeper is recorded as an error (so it
 * is surfaced, not silently dropped) telling the user to move it to the top level.
 * Skips `.git` and the `.okh` dir. Invalid manifests are recorded (not thrown) so
 * one bad module does not hide the rest.
 */
export async function discoverModules(containerRoot: string): Promise<DiscoveredModule[]> {
  const out: DiscoveredModule[] = [];

  let entries;
  try {
    entries = await readdir(containerRoot, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === ".git" || e.name === MODULE_OKH_DIR) continue;
    const abs = join(containerRoot, e.name);
    if (await moduleManifestExists(abs)) {
      try {
        out.push({ path: e.name, manifest: await loadModuleManifest(abs) });
      } catch (err) {
        out.push({ path: e.name, error: err instanceof OkhError ? err.message : String(err) });
      }
      continue;
    }
    // Not a module at the top level: surface any misplaced manifests nested below.
    for (const misplaced of await findMisplacedManifests(containerRoot, e.name)) {
      out.push({
        path: misplaced,
        error: "modules must be top-level folders; move it to the container root.",
      });
    }
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Depth-first search under a non-module top-level folder for stray `.okh/module.yaml` files. */
async function findMisplacedManifests(containerRoot: string, rel: string): Promise<string[]> {
  const found: string[] = [];

  async function recurse(r: string): Promise<void> {
    const abs = join(containerRoot, r);
    if (await moduleManifestExists(abs)) {
      found.push(r);
      return; // do not descend below a discovered (misplaced) module
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
      await recurse(`${r}/${e.name}`);
    }
  }

  await recurse(rel);
  return found;
}
