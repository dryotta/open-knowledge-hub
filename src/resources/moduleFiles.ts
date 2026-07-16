import { readFile, readdir, realpath, stat } from "node:fs/promises";
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

export interface ModuleFilePayload {
  mimeType: string;
  size: number;
  lastModified: string;
  text?: string;
  blob?: string;
}

export function mimeTypeForPath(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
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

function isReadableModuleResourcePath(path: string): boolean {
  const segments = path.split("/");
  const hidden = segments.findIndex((segment) => segment.startsWith("."));
  if (hidden === -1) return true;
  const skillRoot =
    (segments[0] === ".okh" && segments[1] === "skills")
    || (segments[0] === ".claude" && segments[1] === "skills");
  return skillRoot && segments.slice(2).every((segment) => !segment.startsWith("."));
}

export async function listModuleFiles(moduleRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
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
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        await walk(join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
  await walk(moduleRoot, "");
  return files;
}

export async function readModuleFile(
  moduleRoot: string,
  requestedPath: string,
  uri: string,
): Promise<ModuleFilePayload> {
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

  let info;
  try {
    info = await stat(candidateReal);
  } catch (error) {
    throwResourceFileError(error, uri);
  }
  if (!info.isFile()) throw new McpError(-32002, `Resource not found: ${uri}`);
  if (info.size > MAX_RESOURCE_FILE_BYTES) {
    throw new McpError(
      -32602,
      `Resource is ${info.size} bytes; the maximum readable size is ${MAX_RESOURCE_FILE_BYTES} bytes.`,
    );
  }

  let content;
  try {
    content = await readFile(candidateReal);
  } catch (error) {
    throwResourceFileError(error, uri);
  }
  const detectedMimeType = mimeTypeForPath(normalized);
  const binary =
    (!detectedMimeType.startsWith("text/") && !TEXT_APPLICATION_TYPES.has(detectedMimeType))
    || content.subarray(0, Math.min(content.length, 8192)).includes(0);
  return {
    mimeType: binary && detectedMimeType === "application/octet-stream"
      ? "application/octet-stream"
      : detectedMimeType,
    size: info.size,
    lastModified: info.mtime.toISOString(),
    ...(binary
      ? { blob: content.toString("base64") }
      : { text: content.toString("utf8") }),
  };
}
