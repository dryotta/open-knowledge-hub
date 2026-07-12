/** Render a structured sync descriptor as a human-readable string. */
export function formatSyncDescriptor(sync: { mode: string; config?: Record<string, unknown> } | undefined): string {
  if (!sync) return "?";
  if (sync.mode === "shared") {
    const branch = sync.config?.["branch"];
    if (branch) return `shared (branch=${branch})`;
  }
  return sync.mode;
}
