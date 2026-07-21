/** Encode a module-relative path into a flat GitHub-wiki slug. */
export function pathSlug(moduleRelPath: string): string {
  return moduleRelPath.replace(/\.md$/i, "").split("/").join("-");
}
