import { z } from "zod";

/** The five built-in module types. Order is not significant. */
export const BUILTIN_MODULE_TYPES = ["knowledge", "skills", "tools", "memory", "project"] as const;
export const moduleTypeSchema = z.enum(BUILTIN_MODULE_TYPES);
export type ModuleType = (typeof BUILTIN_MODULE_TYPES)[number];

/** A module's on-disk `type` is any non-empty string; unknown => custom. */
export function isBuiltinType(type: string): type is ModuleType {
  return (BUILTIN_MODULE_TYPES as readonly string[]).includes(type);
}

/** A single discoverable unit within a module. `path` is relative to the module root. */
export interface Item {
  /** Path to the item, relative to the module root (POSIX separators). */
  path: string;
  /** Display title (from frontmatter, heading, or folder name). */
  title: string;
  /** One-line description (may be empty). */
  description: string;
  /** Item kind, e.g. an OKF `type`, or "skill"/"tool"/"file". */
  type: string;
}

/**
 * How the Hub loads a module of a given type. Loaders are deterministic and do
 * not interpret content — they enumerate items and surface metadata only.
 */
export interface Loader {
  /** List the module's items with discovery metadata. */
  enumerate(moduleRoot: string): Promise<Item[]>;
  /** The module's entry-point text (OKF index.md, or a generated listing). */
  overview(moduleRoot: string): Promise<string>;
  /** Optionally scaffold a type skeleton into a freshly created module folder. */
  scaffold?(moduleRoot: string): Promise<void>;
}
