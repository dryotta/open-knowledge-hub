import { basename, join } from "node:path";
import { discoverModules } from "../modules/discovery.js";
import type { ModuleManifest, WikiReverseMode } from "../modules/manifest.js";
import { OkhError } from "../errors.js";

export type SelectedWikiModule = {
  /** Absolute path to the module root. */
  moduleRoot: string;
  /** Module folder name (its identity/label). */
  name: string;
  manifest: ModuleManifest;
  /** Resolved reverse-sync mode (defaults to "pr"). */
  reverseMode: WikiReverseMode;
  /**
   * Sidebar expand override from `wiki-sync-expanded`. `undefined` means "use the
   * default" — the renderer expands the first module (alphabetical) and collapses
   * the rest.
   */
  expanded?: boolean;
};

/**
 * Resolve every module a container publishes to its wiki.
 *
 * A module of **any** type opts in with `wiki-sync: true` in its
 * `.okh/module.yaml`. All matches are returned, sorted alphabetically by folder
 * name (a stable, human-meaningful order that also drives the sidebar). Zero
 * matches is a user error.
 */
export async function selectWikiModules(repoRoot: string): Promise<SelectedWikiModule[]> {
  const discovered = await discoverModules(repoRoot);
  const matches = discovered
    .filter((m) => m.manifest?.["wiki-sync"] === true)
    .map((m) => {
      const manifest = m.manifest!;
      return {
        moduleRoot: join(repoRoot, m.path),
        name: basename(m.path),
        manifest,
        reverseMode: manifest["wiki-sync-reverse-mode"] ?? "pr",
        expanded: manifest["wiki-sync-expanded"],
      } satisfies SelectedWikiModule;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (matches.length === 0) {
    throw new OkhError(
      "INVALID_ARGUMENT",
      "No module has 'wiki-sync: true' in its .okh/module.yaml. Mark at least one module to publish.",
    );
  }

  return matches;
}
