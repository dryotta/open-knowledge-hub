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
};

/**
 * Resolve the single knowledge module a container publishes to its wiki.
 *
 * A module opts in with `wiki-sync: true` in its `.okh/module.yaml`. A GitHub
 * wiki is a flat namespace, so exactly one module may be selected: zero or many
 * matches are user errors.
 */
export async function selectWikiModule(repoRoot: string): Promise<SelectedWikiModule> {
  const discovered = await discoverModules(repoRoot);
  const matches = discovered.filter(
    (m) => m.manifest?.type === "knowledge" && m.manifest["wiki-sync"] === true,
  );

  if (matches.length === 0) {
    throw new OkhError(
      "INVALID_ARGUMENT",
      "No knowledge module has 'wiki-sync: true' in its .okh/module.yaml. Mark exactly one to publish.",
    );
  }
  if (matches.length > 1) {
    const names = matches.map((m) => basename(m.path)).join(", ");
    throw new OkhError(
      "INVALID_ARGUMENT",
      `Multiple knowledge modules set 'wiki-sync: true' (${names}). A GitHub wiki is a flat namespace; mark exactly one.`,
    );
  }

  const picked = matches[0]!;
  const manifest = picked.manifest!;
  return {
    moduleRoot: join(repoRoot, picked.path),
    name: basename(picked.path),
    manifest,
    reverseMode: manifest["wiki-sync-reverse-mode"] ?? "pr",
  };
}
