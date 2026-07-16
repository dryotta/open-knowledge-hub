import { isAbsolute, relative, sep } from "node:path";

/** Normalize a user-facing module-relative path, or return undefined when it is unsafe. */
export function normalizeModuleRelativePath(value: string, allowEmpty = false): string | undefined {
  const normalized = value.replace(/\\/gu, "/");
  if (normalized.length === 0) return allowEmpty ? "" : undefined;
  if (
    normalized.includes("\0")
    || normalized.startsWith("/")
    || /^[A-Za-z]:/u.test(normalized)
    || isAbsolute(value)
  ) {
    return undefined;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return undefined;
  }
  return segments.join("/");
}

/** Whether a resolved candidate path remains inside a resolved root path. */
export function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
