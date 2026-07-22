import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isPathWithin } from "./pathSafety.js";

export const MAX_AGENTS_FILE_BYTES = 256 * 1024;

export type AgentsFileResult =
  | { status: "present"; content: string }
  | { status: "absent" }
  | { status: "unsafe"; reason: string };

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Read `<moduleRoot>/AGENTS.md` with the same guards used for agent profiles:
 * no symlinks, resolved path must stay within the module root, 256 KiB cap, UTF-8.
 * Returns `absent` when the file does not exist, `unsafe` (with a reason) when it
 * exists but cannot be read safely, and `present` (with content) otherwise.
 */
export async function readModuleAgentsFile(moduleRoot: string): Promise<AgentsFileResult> {
  const path = join(moduleRoot, "AGENTS.md");
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if (isNotFound(err)) return { status: "absent" };
    return { status: "unsafe", reason: "the file could not be inspected" };
  }
  if (info.isSymbolicLink()) return { status: "unsafe", reason: "symbolic links are not allowed" };
  if (!info.isFile()) return { status: "unsafe", reason: "AGENTS.md is not a regular file" };

  let moduleRootReal: string;
  let candidateReal: string;
  try {
    moduleRootReal = await realpath(moduleRoot);
    candidateReal = await realpath(path);
  } catch {
    return { status: "unsafe", reason: "the file could not be resolved" };
  }
  if (!isPathWithin(moduleRootReal, candidateReal)) {
    return { status: "unsafe", reason: "the file resolves outside the module root" };
  }

  let handle;
  try {
    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    handle = await open(candidateReal, constants.O_RDONLY | noFollow);
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) return { status: "unsafe", reason: "AGENTS.md is not a regular file" };
    if (openedInfo.size > MAX_AGENTS_FILE_BYTES) {
      return { status: "unsafe", reason: `AGENTS.md exceeds the ${MAX_AGENTS_FILE_BYTES}-byte limit` };
    }
    const bytes = await handle.readFile();
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return { status: "unsafe", reason: "AGENTS.md is not valid UTF-8" };
    }
    return { status: "present", content };
  } catch {
    return { status: "unsafe", reason: "AGENTS.md could not be read safely" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
