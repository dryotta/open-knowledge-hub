import { constants, type Stats } from "node:fs";
import { opendir, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { isPathWithin, normalizeModuleRelativePath } from "../modules/pathSafety.js";

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
]);

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".py": "text/x-python",
  ".svg": "image/svg+xml",
  ".toml": "application/toml",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/toml",
  "application/xml",
  "application/yaml",
]);

export const MAX_RESOURCE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_MODULE_INDEX_FILES = 1_000;
export const MAX_MODULE_INDEX_ENTRIES = 10_000;
export const MAX_MODULE_INDEX_DEPTH = 32;

export interface ModuleFileListOptions {
  maxFiles?: number;
  maxEntries?: number;
  maxDepth?: number;
}

export interface ModuleFileListing {
  files: string[];
  truncated: boolean;
}

export interface ModuleFilePayload {
  mimeType: string;
  size: number;
  lastModified: string;
  text?: string;
  blob?: string;
}

export interface ModuleFileMetadata {
  mimeType: string;
  size: number;
  lastModified: string;
}

interface OpenedModuleFile extends ModuleFileMetadata {
  handle: FileHandle;
}

export function mimeTypeForPath(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function isDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

function throwResourceFileError(error: unknown, uri: string): never {
  if (isMissing(error)) throw new McpError(-32002, `Resource not found: ${uri}`);
  if (typeof (error as NodeJS.ErrnoException).code === "string") {
    throw new McpError(-32603, `Resource cannot be read: ${uri}`);
  }
  throw error;
}

function throwModuleListError(error: unknown): never {
  if (isMissing(error)) {
    throw new McpError(-32002, "Module resources are no longer available.");
  }
  if (isDenied(error)) {
    throw new McpError(-32603, "Module resources cannot be read.");
  }
  if (typeof (error as NodeJS.ErrnoException).code === "string") {
    throw new McpError(-32603, "Module resources cannot be listed.");
  }
  throw error;
}

function isReadableModuleResourcePath(path: string): boolean {
  const segments = path.split("/");
  const hidden = segments.findIndex((segment) => segment.startsWith("."));
  if (hidden === -1) return true;
  const skillRoot =
    (segments[0] === ".okh" && segments[1] === "skills")
    || (segments[0] === ".claude" && segments[1] === "skills");
  return skillRoot && segments.slice(2).every((segment) => !segment.startsWith("."));
}

export async function listModuleFiles(
  moduleRoot: string,
  options: ModuleFileListOptions = {},
): Promise<ModuleFileListing> {
  const {
    maxFiles = MAX_MODULE_INDEX_FILES,
    maxEntries = MAX_MODULE_INDEX_ENTRIES,
    maxDepth = MAX_MODULE_INDEX_DEPTH,
  } = options;
  const files: string[] = [];
  let visitedEntries = 0;
  let truncated = false;

  async function walk(
    directory: string,
    relativeDirectory: string,
    depth: number,
  ): Promise<void> {
    try {
      const entries = await opendir(directory);
      for await (const entry of entries) {
        if (visitedEntries >= maxEntries || files.length >= maxFiles) {
          truncated = true;
          break;
        }
        visitedEntries += 1;
        if (entry.name.startsWith(".")) continue;
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        if (entry.isDirectory()) {
          if (SKIP_DIRECTORIES.has(entry.name)) continue;
          if (depth >= maxDepth) {
            truncated = true;
            continue;
          }
          await walk(join(directory, entry.name), relativePath, depth + 1);
        } else if (entry.isFile()) {
          files.push(relativePath);
        }
      }
    } catch (error) {
      throwModuleListError(error);
    }
  }
  await walk(moduleRoot, "", 0);
  return { files: files.sort(), truncated };
}

function sameFile(
  opened: Stats,
  current: Stats,
): boolean {
  return opened.dev === current.dev && opened.ino === current.ino;
}

async function openModuleFile(
  moduleRoot: string,
  requestedPath: string,
  uri: string,
): Promise<OpenedModuleFile> {
  const normalized = normalizeModuleRelativePath(requestedPath);
  if (!normalized || !isReadableModuleResourcePath(normalized)) {
    throw new McpError(-32002, `Resource not found: ${uri}`);
  }

  let rootReal: string;
  try {
    rootReal = await realpath(moduleRoot);
  } catch (error) {
    throwResourceFileError(error, uri);
  }
  const candidate = resolve(moduleRoot, ...normalized.split("/"));
  let candidateReal: string;
  try {
    candidateReal = await realpath(candidate);
  } catch (error) {
    throwResourceFileError(error, uri);
  }
  if (!isPathWithin(rootReal, candidateReal)) {
    throw new McpError(-32002, `Resource not found: ${uri}`);
  }

  let handle: FileHandle;
  try {
    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    handle = await open(candidateReal, constants.O_RDONLY | noFollow);
  } catch (error) {
    throwResourceFileError(error, uri);
  }

  try {
    const [info, currentReal] = await Promise.all([
      handle.stat(),
      realpath(candidate),
    ]);
    if (!info.isFile() || !isPathWithin(rootReal, currentReal)) {
      throw new McpError(-32002, `Resource not found: ${uri}`);
    }
    const currentInfo = await stat(currentReal);
    if (!sameFile(info, currentInfo)) {
      throw new McpError(-32002, `Resource not found: ${uri}`);
    }
    return {
      handle,
      mimeType: mimeTypeForPath(normalized),
      size: info.size,
      lastModified: info.mtime.toISOString(),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof McpError) throw error;
    throwResourceFileError(error, uri);
  }
}

export async function moduleFileMetadata(
  moduleRoot: string,
  requestedPath: string,
  uri: string,
): Promise<ModuleFileMetadata> {
  const opened = await openModuleFile(
    moduleRoot,
    requestedPath,
    uri,
  );
  try {
    const { mimeType, size, lastModified } = opened;
    return { mimeType, size, lastModified };
  } finally {
    await opened.handle.close();
  }
}

export async function readModuleFile(
  moduleRoot: string,
  requestedPath: string,
  uri: string,
  maxBytes = MAX_RESOURCE_FILE_BYTES,
): Promise<ModuleFilePayload> {
  const readLimit = Math.min(maxBytes, MAX_RESOURCE_FILE_BYTES);
  const opened = await openModuleFile(moduleRoot, requestedPath, uri);
  try {
    if (opened.size > readLimit) {
      throw new McpError(
        -32602,
        `Resource is ${opened.size} bytes; the maximum readable size is ${readLimit} bytes.`,
      );
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= readLimit) {
      const remaining = readLimit + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await opened.handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > readLimit) {
      throw new McpError(
        -32602,
        `Resource exceeds the maximum readable size of ${readLimit} bytes.`,
      );
    }

    const content = Buffer.concat(chunks, total);
    let binary =
      (!opened.mimeType.startsWith("text/") && !TEXT_APPLICATION_TYPES.has(opened.mimeType))
      || content.subarray(0, Math.min(content.length, 8192)).includes(0);
    let text: string | undefined;
    if (!binary) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch {
        binary = true;
      }
    }
    const finalInfo = await opened.handle.stat();
    return {
      mimeType: binary && opened.mimeType === "application/octet-stream"
        ? "application/octet-stream"
        : opened.mimeType,
      size: total,
      lastModified: finalInfo.mtime.toISOString(),
      ...(binary
        ? { blob: content.toString("base64") }
        : { text: text! }),
    };
  } catch (error) {
    if (error instanceof McpError) throw error;
    throwResourceFileError(error, uri);
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}
