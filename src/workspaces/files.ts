import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { OkhPaths } from "../config.js";
import { OkhError } from "../errors.js";
import { isPathWithin } from "../modules/pathSafety.js";
import type { ResultFile } from "./types.js";

export const MAX_RESULT_FILES = 1000;
export const MAX_RESULT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_RESULT_TOTAL_BYTES = 256 * 1024 * 1024;

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compareStrings(left, right));
  return `{${entries.map(([key, entry]) =>
    `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function sameFile(opened: Stats, current: Stats): boolean {
  return opened.dev === current.dev && opened.ino === current.ino;
}

function notFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function assertSafePath(
  root: string,
  candidate: string,
  options: { allowMissing?: boolean; requireDirectory?: boolean } = {},
): Promise<void> {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (!isPathWithin(rootPath, candidatePath)) {
    throw new OkhError("INVALID_MANIFEST", `"${candidate}" escapes its workspace boundary.`);
  }
  const rootInfo = await lstat(rootPath).catch((error) => {
    if (notFound(error)) throw new OkhError("NOT_FOUND", `Workspace boundary "${root}" does not exist.`);
    throw error;
  });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new OkhError("INVALID_MANIFEST", `Workspace boundary "${root}" is not a safe directory.`);
  }
  const rootReal = await realpath(rootPath);
  const parts = relative(rootPath, candidatePath).split(sep).filter(Boolean);
  let current = rootPath;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (notFound(error) && options.allowMissing) return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new OkhError(
        "INVALID_MANIFEST",
        `Workspace path "${relative(rootPath, current)}" cannot be a symbolic link or junction.`,
      );
    }
    const currentReal = await realpath(current);
    if (!isPathWithin(rootReal, currentReal)) {
      throw new OkhError(
        "INVALID_MANIFEST",
        `Workspace path "${relative(rootPath, current)}" resolves outside its boundary.`,
      );
    }
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new OkhError(
        "INVALID_MANIFEST",
        `Workspace path "${relative(rootPath, current)}" is not a directory.`,
      );
    }
    if (index === parts.length - 1 && options.requireDirectory && !info.isDirectory()) {
      throw new OkhError("INVALID_MANIFEST", `"${candidate}" is not a directory.`);
    }
  }
}

export async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  const rootPath = resolve(root);
  const directoryPath = resolve(directory);
  if (!isPathWithin(rootPath, directoryPath)) {
    throw new OkhError("INVALID_MANIFEST", `"${directory}" escapes its workspace boundary.`);
  }
  await assertSafePath(rootPath, rootPath, { requireDirectory: true });
  const parts = relative(rootPath, directoryPath).split(sep).filter(Boolean);
  let current = rootPath;
  for (const part of parts) {
    current = join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertSafePath(rootPath, current, { requireDirectory: true });
  }
}

async function openSafeRegularFile(root: string, path: string): Promise<{
  handle: FileHandle;
  info: Stats;
}> {
  await assertSafePath(root, path);
  const rootReal = await realpath(root);
  const candidateReal = await realpath(path);
  if (!isPathWithin(rootReal, candidateReal)) {
    throw new OkhError("INVALID_MANIFEST", `"${path}" resolves outside its workspace boundary.`);
  }
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(candidateReal, constants.O_RDONLY | noFollow);
  try {
    const [info, currentReal] = await Promise.all([handle.stat(), realpath(path)]);
    if (!info.isFile() || !isPathWithin(rootReal, currentReal)) {
      throw new OkhError("INVALID_MANIFEST", `"${path}" is not a safe regular file.`);
    }
    const currentInfo = await stat(currentReal);
    if (!sameFile(info, currentInfo)) {
      throw new OkhError("CONFLICT", `"${path}" changed while it was being opened.`);
    }
    return { handle, info };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function readSafeFile(root: string, path: string): Promise<Buffer> {
  const { handle } = await openSafeRegularFile(root, path);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readSafeTextFile(root: string, path: string): Promise<string> {
  return (await readSafeFile(root, path)).toString("utf8");
}

export async function fileEtag(path: string, root = dirname(path)): Promise<string> {
  return sha256(await readSafeFile(root, path));
}

export async function atomicWrite(
  path: string,
  content: string | Buffer,
  root = dirname(path),
): Promise<void> {
  await ensureSafeDirectory(root, dirname(path));
  const existing = await lstat(path).catch((error) => {
    if (notFound(error)) return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new OkhError("INVALID_MANIFEST", `"${path}" is not a safe regular file.`);
  }
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await assertSafePath(root, dirname(path), { requireDirectory: true });
    await rename(temporary, path);
    await assertSafePath(root, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function safeRelativePath(value: string, allowDot = false): string {
  const trimmed = value.trim().replace(/\\/gu, "/");
  if (allowDot && trimmed === ".") return ".";
  if (
    !trimmed
    || trimmed.startsWith("/")
    || /^[a-z]:/iu.test(trimmed)
    || trimmed.includes("\0")
    || trimmed.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new OkhError("INVALID_ARGUMENT", `"${value}" is not a safe relative path.`);
  }
  return trimmed;
}

export function safeJoin(root: string, relativePath: string): string {
  const normalized = safeRelativePath(relativePath);
  const candidate = resolve(root, ...normalized.split("/"));
  if (!isPathWithin(root, candidate)) {
    throw new OkhError("INVALID_ARGUMENT", `"${relativePath}" escapes its allowed root.`);
  }
  return candidate;
}

export function workspaceStagingRoot(paths: OkhPaths): string {
  return join(paths.home, "workspace-staging");
}

export function stagingDirectory(
  paths: OkhPaths,
  container: string,
  module: string,
  project: string,
  run: string,
): string {
  const root = workspaceStagingRoot(paths);
  const path = resolve(root, container, module, project, run);
  if (!isPathWithin(root, path)) {
    throw new OkhError("INVALID_ARGUMENT", "Workspace staging path escapes the OKH state directory.");
  }
  return path;
}

async function walkTree(
  boundary: string,
  root: string,
  current: string,
  files: ResultFile[],
  totals: { bytes: number },
): Promise<void> {
  await assertSafePath(boundary, current, { requireDirectory: true });
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    const absolute = join(current, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new OkhError("INVALID_ARGUMENT", `Result path "${relative(root, absolute)}" is a symbolic link.`);
    }
    if (info.isDirectory()) {
      await walkTree(boundary, root, absolute, files, totals);
      continue;
    }
    if (!info.isFile()) {
      throw new OkhError("INVALID_ARGUMENT", `Result path "${relative(root, absolute)}" is not a regular file.`);
    }
    if (info.size > MAX_RESULT_FILE_BYTES) {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Result file "${relative(root, absolute)}" exceeds ${MAX_RESULT_FILE_BYTES} bytes.`,
      );
    }
    const bytes = await readSafeFile(boundary, absolute);
    if (bytes.length !== info.size) {
      throw new OkhError("CONFLICT", `Result file "${relative(root, absolute)}" changed while reading.`);
    }
    files.push({
      path: relative(root, absolute).split(sep).join("/"),
      size: bytes.length,
      sha256: sha256(bytes),
    });
    if (files.length > MAX_RESULT_FILES) {
      throw new OkhError("INVALID_ARGUMENT", `Result exceeds ${MAX_RESULT_FILES} files.`);
    }
    totals.bytes += info.size;
    if (totals.bytes > MAX_RESULT_TOTAL_BYTES) {
      throw new OkhError("INVALID_ARGUMENT", `Result exceeds ${MAX_RESULT_TOTAL_BYTES} bytes.`);
    }
  }
}

export async function inspectResultTree(root: string, boundary = root): Promise<{
  files: ResultFile[];
  treeHash: string;
}> {
  await assertSafePath(boundary, root, { requireDirectory: true });
  const rootInfo = await lstat(root).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new OkhError("NOT_FOUND", "The staged result directory does not exist or is unsafe.");
  }
  const files: ResultFile[] = [];
  await walkTree(boundary, root, root, files, { bytes: 0 });
  files.sort((left, right) => compareStrings(left.path, right.path));
  return { files, treeHash: sha256(canonicalJson(files)) };
}

export async function publishResult(
  source: string,
  destination: string,
  expected: { files: ResultFile[]; treeHash: string },
  sourceBoundary = source,
  destinationBoundary = dirname(destination),
): Promise<{
  files: ResultFile[];
  treeHash: string;
}> {
  await assertSafePath(sourceBoundary, source, { requireDirectory: true });
  await assertSafePath(destinationBoundary, destination, { allowMissing: true });
  const destinationInfo = await lstat(destination).catch((error) => {
    if (notFound(error)) return undefined;
    throw error;
  });
  if (destinationInfo) {
    throw new OkhError("CONFLICT", "This run already has a published result.");
  }
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await removeSafeTree(destinationBoundary, temporary);
  try {
    await ensureSafeDirectory(destinationBoundary, temporary);
    for (const file of expected.files) {
      const sourcePath = safeJoin(source, file.path);
      const bytes = await readSafeFile(sourceBoundary, sourcePath);
      if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
        throw new OkhError("CONFLICT", `Staged result file "${file.path}" changed before publication.`);
      }
      await atomicWrite(safeJoin(temporary, file.path), bytes, destinationBoundary);
    }
    const copied = await inspectResultTree(temporary, destinationBoundary);
    const current = await inspectResultTree(source, sourceBoundary);
    if (
      copied.treeHash !== expected.treeHash
      || current.treeHash !== expected.treeHash
      || canonicalJson(copied.files) !== canonicalJson(expected.files)
    ) {
      throw new OkhError("CONFLICT", "Staging changed while the result was being published.");
    }
    await assertSafePath(destinationBoundary, dirname(destination), { requireDirectory: true });
    await rename(temporary, destination);
    await assertSafePath(destinationBoundary, destination, { requireDirectory: true });
    return copied;
  } catch (error) {
    await removeSafeTree(destinationBoundary, temporary).catch(() => undefined);
    throw error;
  }
}

export async function copySnapshotFile(
  source: string,
  destination: string,
  sourceBoundary = dirname(source),
  destinationBoundary = dirname(destination),
): Promise<string> {
  const bytes = await readSafeFile(sourceBoundary, source).catch((error) => {
    if (notFound(error)) {
      throw new OkhError("NOT_FOUND", `Snapshot source "${source}" does not exist.`);
    }
    throw error;
  });
  await atomicWrite(destination, bytes, destinationBoundary);
  return sha256(bytes);
}

export function resolveStagingResult(staging: string, resultPath: string): string {
  if (resultPath.trim() === ".") return staging;
  const relativePath = safeRelativePath(resultPath);
  const candidate = resolve(staging, ...relativePath.split("/"));
  if (!isPathWithin(staging, candidate) || isAbsolute(relative(staging, candidate))) {
    throw new OkhError("INVALID_ARGUMENT", "resultPath escapes staging.");
  }
  return candidate;
}

export async function removeSafeTree(root: string, target: string): Promise<void> {
  const info = await lstat(target).catch((error) => {
    if (notFound(error)) return undefined;
    throw error;
  });
  if (!info) return;
  await assertSafePath(root, target);
  if (info.isSymbolicLink()) {
    throw new OkhError("INVALID_MANIFEST", `"${target}" cannot be a symbolic link or junction.`);
  }
  await rm(target, { recursive: true, force: true });
}

export function nextRunId(existingRunIds: readonly string[], now: Date): string {
  const date = now.toISOString().slice(0, 10);
  const prefix = `${date}-`;
  const sequence = existingRunIds
    .filter((runId) => runId.startsWith(prefix))
    .map((runId) => Number(runId.slice(prefix.length)))
    .filter((value) => Number.isInteger(value) && value > 0)
    .reduce((maximum, value) => Math.max(maximum, value), 0) + 1;
  return `${date}-${String(sequence).padStart(3, "0")}`;
}
