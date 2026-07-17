import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { OkhError } from "../../errors.js";
import { isPathWithin } from "../pathSafety.js";
import type { Item, Loader } from "../types.js";

export const AGENT_PROFILE_DIRECTORY = ".github/agents";
export const MAX_AGENT_PROFILE_BYTES = 256 * 1024;
export const MAX_AGENT_PROMPT_CHARS = 30_000;

const AGENT_PROFILE_PARTS = [".github", "agents"] as const;
const FRONTMATTER_RE = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export interface AgentProfile {
  id: string;
  path: string;
  description: string;
  content: string;
  frontmatter: Record<string, unknown>;
  requestedTools: string[];
}

export interface AgentProfileIssue {
  path: string;
  message: string;
  agentId?: string;
}

export interface AgentProfileScan {
  profiles: AgentProfile[];
  issues: AgentProfileIssue[];
}

interface Candidate {
  id: string;
  fileName: string;
  path: string;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function profileId(fileName: string): string | undefined {
  if (fileName.endsWith(".agent.md")) return fileName.slice(0, -".agent.md".length);
  if (fileName.endsWith(".md")) return fileName.slice(0, -".md".length);
  return undefined;
}

function isSafeAgentId(id: string): boolean {
  return (
    id.length > 0 &&
    id === id.trim() &&
    id !== "." &&
    id !== ".." &&
    !/[\/\\\0-\x1f\x7f]/.test(id)
  );
}

function profilePath(fileName: string): string {
  return `${AGENT_PROFILE_DIRECTORY}/${fileName}`;
}

function requestedTools(frontmatter: Record<string, unknown>): string[] {
  const tools = frontmatter.tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (tool): tool is string => typeof tool === "string" && tool.trim().length > 0,
  );
}

function sameFile(
  opened: Stats,
  current: Stats,
): boolean {
  return opened.dev === current.dev && opened.ino === current.ino;
}

async function readCandidate(
  moduleRoot: string,
  profileRootReal: string,
  candidate: Candidate,
): Promise<AgentProfile | AgentProfileIssue> {
  const absolutePath = join(moduleRoot, ...AGENT_PROFILE_PARTS, candidate.fileName);
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (err) {
    return {
      path: candidate.path,
      agentId: candidate.id,
      message: isNotFound(err) ? "profile disappeared while loading" : "profile cannot be inspected",
    };
  }
  if (info.isSymbolicLink()) {
    return {
      path: candidate.path,
      agentId: candidate.id,
      message: "symbolic links are not allowed",
    };
  }
  if (!info.isFile()) {
    return {
      path: candidate.path,
      agentId: candidate.id,
      message: "profile must be a regular file",
    };
  }
  let candidateReal: string;
  try {
    candidateReal = await realpath(absolutePath);
  } catch {
    return {
      path: candidate.path,
      agentId: candidate.id,
      message: "profile cannot be resolved",
    };
  }
  if (!isPathWithin(profileRootReal, candidateReal)) {
    return {
      path: candidate.path,
      agentId: candidate.id,
      message: "profile resolves outside the agents directory",
    };
  }

  let bytes: Buffer;
  let handle: FileHandle | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    handle = await open(candidateReal, constants.O_RDONLY | noFollow);
    const [openedInfo, currentLinkInfo, currentReal] = await Promise.all([
      handle.stat(),
      lstat(absolutePath),
      realpath(absolutePath),
    ]);
    if (
      currentLinkInfo.isSymbolicLink()
      || !openedInfo.isFile()
      || !isPathWithin(profileRootReal, currentReal)
    ) {
      return {
        path: candidate.path,
        agentId: candidate.id,
        message: "profile changed to an unsafe path while loading",
      };
    }
    const currentInfo = await stat(currentReal);
    if (!sameFile(openedInfo, currentInfo)) {
      return {
        path: candidate.path,
        agentId: candidate.id,
        message: "profile changed while loading",
      };
    }
    if (openedInfo.size > MAX_AGENT_PROFILE_BYTES) {
      return {
        path: candidate.path,
        agentId: candidate.id,
        message: `profile exceeds the ${MAX_AGENT_PROFILE_BYTES}-byte file limit`,
      };
    }
    bytes = await handle.readFile();
  } catch {
    return {
      path: candidate.path,
      agentId: candidate.id,
      message: "profile cannot be read safely",
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (bytes.byteLength > MAX_AGENT_PROFILE_BYTES) {
    return {
      path: candidate.path,
      agentId: candidate.id,
      message: `profile exceeds the ${MAX_AGENT_PROFILE_BYTES}-byte file limit`,
    };
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return {
      path: candidate.path,
      agentId: candidate.id,
      message: "profile is not valid UTF-8",
    };
  }

  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return {
      path: candidate.path,
      agentId: candidate.id,
      message: "profile must start with a YAML frontmatter block",
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]!);
  } catch {
    return {
      path: candidate.path,
      agentId: candidate.id,
      message: "frontmatter is not valid YAML",
    };
  }
  if (!isRecord(parsed)) {
    return {
      path: candidate.path,
      agentId: candidate.id,
      message: "frontmatter must be a YAML mapping",
    };
  }

  const description = parsed.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    return {
      path: candidate.path,
      agentId: candidate.id,
      message: 'frontmatter requires a non-empty string "description"',
    };
  }

  const prompt = content.slice(match[0].length);
  if (Array.from(prompt).length > MAX_AGENT_PROMPT_CHARS) {
    return {
      path: candidate.path,
      agentId: candidate.id,
      message: `prompt exceeds the ${MAX_AGENT_PROMPT_CHARS}-character limit`,
    };
  }

  return {
    id: candidate.id,
    path: candidate.path,
    description: description.trim(),
    content,
    frontmatter: parsed,
    requestedTools: requestedTools(parsed),
  };
}

async function inspectNestedDirectory(
  absoluteDirectory: string,
  relativeDirectory: string,
  issues: AgentProfileIssue[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    issues.push({
      path: relativeDirectory,
      message: "directory cannot be read",
    });
    return;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      issues.push({ path: relativePath, message: "symbolic links are not allowed" });
      continue;
    }
    if (entry.isDirectory()) {
      await inspectNestedDirectory(
        join(absoluteDirectory, entry.name),
        relativePath,
        issues,
      );
      continue;
    }
    if (entry.isFile() && profileId(entry.name) !== undefined) {
      issues.push({
        path: relativePath,
        message: `nested profiles are not supported; move the file directly under ${AGENT_PROFILE_DIRECTORY}`,
      });
    }
  }
}

async function misplacedRootProfileIssues(moduleRoot: string): Promise<AgentProfileIssue[]> {
  let entries;
  try {
    entries = await readdir(moduleRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const issues: AgentProfileIssue[] = [];
  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith(".agent.md")) continue;
    issues.push({
      path: entry.name,
      message: entry.isFile()
        ? `agent profiles must be located directly under ${AGENT_PROFILE_DIRECTORY}`
        : "misplaced agent profile path must be a regular file",
    });
  }
  return issues.sort((a, b) => a.path.localeCompare(b.path));
}

async function profileDirectory(
  moduleRoot: string,
): Promise<{ path?: string; realPath?: string; issues: AgentProfileIssue[] }> {
  const issues: AgentProfileIssue[] = [];
  let moduleInfo;
  try {
    moduleInfo = await lstat(moduleRoot);
  } catch (err) {
    return {
      issues: [{
        path: ".",
        message: isNotFound(err) ? "module root does not exist" : "module root cannot be inspected",
      }],
    };
  }
  if (moduleInfo.isSymbolicLink()) {
    return { issues: [{ path: ".", message: "module root cannot be a symbolic link" }] };
  }
  if (!moduleInfo.isDirectory()) {
    return { issues: [{ path: ".", message: "module root must be a directory" }] };
  }

  let moduleRootReal: string;
  try {
    moduleRootReal = await realpath(moduleRoot);
  } catch {
    return { issues: [{ path: ".", message: "module root cannot be resolved" }] };
  }
  let current = moduleRoot;
  let relative = "";

  for (const part of AGENT_PROFILE_PARTS) {
    current = join(current, part);
    relative = relative ? `${relative}/${part}` : part;
    let info;
    try {
      info = await lstat(current);
    } catch (err) {
      if (isNotFound(err)) return { issues };
      issues.push({
        path: AGENT_PROFILE_DIRECTORY,
        message: `${relative} cannot be inspected`,
      });
      return { issues };
    }
    if (info.isSymbolicLink()) {
      issues.push({ path: relative, message: "symbolic links are not allowed" });
      return { issues };
    }
    if (!info.isDirectory()) {
      issues.push({ path: relative, message: "expected a directory" });
      return { issues };
    }
  }

  let currentReal: string;
  try {
    currentReal = await realpath(current);
  } catch {
    return {
      issues: [{ path: AGENT_PROFILE_DIRECTORY, message: "directory cannot be resolved" }],
    };
  }
  if (!isPathWithin(moduleRootReal, currentReal)) {
    return {
      issues: [{
        path: AGENT_PROFILE_DIRECTORY,
        message: "directory resolves outside the module root",
      }],
    };
  }

  return { path: current, realPath: currentReal, issues };
}

export async function scanAgentProfiles(moduleRoot: string): Promise<AgentProfileScan> {
  const [directory, misplacedIssues] = await Promise.all([
    profileDirectory(moduleRoot),
    misplacedRootProfileIssues(moduleRoot),
  ]);
  const issues = [...directory.issues, ...misplacedIssues];
  if (!directory.path || !directory.realPath) {
    issues.sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));
    return { profiles: [], issues };
  }

  let entries;
  try {
    entries = await readdir(directory.path, { withFileTypes: true });
  } catch {
    return {
      profiles: [],
      issues: [{ path: AGENT_PROFILE_DIRECTORY, message: "directory cannot be read" }],
    };
  }

  const candidates: Candidate[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = profilePath(entry.name);
    if (entry.isSymbolicLink()) {
      issues.push({ path, message: "symbolic links are not allowed" });
      continue;
    }
    if (entry.isDirectory()) {
      await inspectNestedDirectory(join(directory.path, entry.name), path, issues);
      continue;
    }

    const id = profileId(entry.name);
    if (id === undefined) continue;
    if (!entry.isFile()) {
      issues.push({ path, message: "profile must be a regular file" });
      continue;
    }
    if (!isSafeAgentId(id)) {
      issues.push({ path, message: "profile filename does not produce a safe agent ID" });
      continue;
    }
    candidates.push({ id, fileName: entry.name, path });
  }

  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = candidate.id.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  const unique: Candidate[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      unique.push(group[0]!);
      continue;
    }
    const files = group.map((candidate) => candidate.fileName).join(", ");
    issues.push({
      path: AGENT_PROFILE_DIRECTORY,
      agentId: group[0]!.id,
      message: `duplicate agent ID "${group[0]!.id}" from: ${files}`,
    });
  }

  const profiles: AgentProfile[] = [];
  for (const candidate of unique) {
    const result = await readCandidate(moduleRoot, directory.realPath, candidate);
    if ("content" in result) profiles.push(result);
    else issues.push(result);
  }

  profiles.sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
  issues.sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));
  return { profiles, issues };
}

export async function resolveAgentProfile(
  moduleRoot: string,
  agentId: string,
): Promise<AgentProfile> {
  if (!isSafeAgentId(agentId)) {
    throw new OkhError("INVALID_ARGUMENT", "agent must be a safe, non-empty profile ID.");
  }

  const scan = await scanAgentProfiles(moduleRoot);
  const normalizedId = agentId.toLowerCase();
  const profile = scan.profiles.find((candidate) => candidate.id.toLowerCase() === normalizedId);
  if (profile) return profile;

  const rejected = scan.issues.find((issue) => issue.agentId?.toLowerCase() === normalizedId);
  if (rejected) {
    throw new OkhError(
      "INVALID_MANIFEST",
      `Agent "${agentId}" is invalid: ${rejected.path}: ${rejected.message}.`,
    );
  }
  if (scan.profiles.length === 0 && scan.issues.length > 0) {
    throw new OkhError(
      "INVALID_MANIFEST",
      `Agents module is invalid: ${scan.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}.`,
    );
  }

  const available = scan.profiles.map((candidate) => candidate.id).join(", ") || "(none)";
  throw new OkhError(
    "NOT_FOUND",
    `Agents module has no agent "${agentId}". Available: ${available}.`,
  );
}

async function enumerate(moduleRoot: string): Promise<Item[]> {
  const { profiles } = await scanAgentProfiles(moduleRoot);
  return profiles.map((profile) => ({
    path: profile.path,
    title: profile.id,
    description: profile.description,
    type: "agent",
  }));
}

async function overview(moduleRoot: string): Promise<string> {
  const items = await enumerate(moduleRoot);
  if (items.length === 0) return "# Agents\n\n_No valid agent profiles._\n";
  const lines = items.map(
    (item) => `* **${item.title}** — ${item.description} (\`${item.path}\`)`,
  );
  return `# Agents\n\n${lines.join("\n")}\n`;
}

async function validate(moduleRoot: string): Promise<string[]> {
  const { issues } = await scanAgentProfiles(moduleRoot);
  return issues.map((issue) => `${issue.path}: ${issue.message}`);
}

async function scaffold(moduleRoot: string): Promise<void> {
  const directory = join(moduleRoot, ...AGENT_PROFILE_PARTS);
  await mkdir(directory, { recursive: true });
}

export const agentsLoader: Loader = {
  enumerate,
  overview,
  scaffold,
  validate,
};
