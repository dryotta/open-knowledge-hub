import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { walkFiles } from "../../src/modules/fs.js";
import { parseTodoLine } from "../../src/todos/parser.js";
import { TODO_PRIORITIES, type ParsedTodoLine } from "../../src/todos/types.js";

interface TodoAssertionConfig {
  module?: string;
  text: string;
  status?: "open" | "completed";
  labels?: string[];
  due?: string;
  priority?: string;
}

interface Context {
  config?: unknown;
  providerResponse?: { metadata?: { containerPath?: unknown } };
}

interface NormalizedConfig {
  module: string;
  moduleParts: string[];
  text: string;
  status?: "open" | "completed";
  labels: string[];
  due?: string;
  priority?: string;
}

interface Candidate {
  path: string;
  line: number;
  parsed: ParsedTodoLine;
}

interface AssertionResult {
  pass: boolean;
  score: number;
  reason: string;
}

const failure = (reason: string): AssertionResult => ({ pass: false, score: 0, reason });

function normalizeLabel(label: string): string {
  return label.trim().replace(/^#+/u, "").toLowerCase();
}

function normalizeConfig(raw: unknown): NormalizedConfig | AssertionResult {
  if (raw === undefined || raw === null) return failure("missing assertion config");
  if (typeof raw !== "object" || Array.isArray(raw)) return failure("assertion config must be an object");

  const config = raw as Partial<Record<keyof TodoAssertionConfig, unknown>>;
  if (typeof config.text !== "string" || config.text.trim().length === 0) {
    return failure("config.text must be a non-empty string");
  }

  if (config.module !== undefined && typeof config.module !== "string") {
    return failure("config.module must be a non-empty relative path");
  }
  const module = config.module === undefined ? "mem" : config.module.trim();
  const moduleParts = module.split(/[\\/]/u);
  if (
    module.length === 0
    || isAbsolute(module)
    || moduleParts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return failure("config.module must be a non-empty relative path");
  }

  if (config.status !== undefined && config.status !== "open" && config.status !== "completed") {
    return failure('config.status must be "open" or "completed"');
  }

  let labels: string[] = [];
  if (config.labels !== undefined) {
    if (!Array.isArray(config.labels) || config.labels.some((label) => typeof label !== "string")) {
      return failure("config.labels must be an array of strings");
    }
    labels = [...new Set(config.labels.map((label) => normalizeLabel(label as string)))].sort();
    if (labels.some((label) => label.length === 0)) {
      return failure("config.labels must contain non-empty label names");
    }
  }

  if (config.due !== undefined && typeof config.due !== "string") {
    return failure("config.due must be a non-empty string");
  }
  const due = config.due === undefined ? undefined : config.due.trim();
  if (due !== undefined && due.length === 0) return failure("config.due must be a non-empty string");

  if (config.priority !== undefined && typeof config.priority !== "string") {
    return failure(`config.priority must be one of: ${TODO_PRIORITIES.join(", ")}`);
  }
  const priority = config.priority === undefined ? undefined : config.priority.trim().toLowerCase();
  if (
    priority !== undefined
    && (
      !priority
      || !(TODO_PRIORITIES as readonly string[]).includes(priority)
    )
  ) {
    return failure(`config.priority must be one of: ${TODO_PRIORITIES.join(", ")}`);
  }

  return {
    module: moduleParts.join("/"),
    moduleParts,
    text: config.text.trim().toLowerCase(),
    ...(config.status === undefined ? {} : { status: config.status }),
    labels,
    ...(due === undefined ? {} : { due }),
    ...(priority === undefined ? {} : { priority }),
  };
}

function filesystemCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function directoryState(path: string): Promise<"directory" | "missing" | "unreadable" | "other"> {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "other";
  } catch (error) {
    const code = filesystemCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    if (code === "EACCES" || code === "EPERM") return "unreadable";
    throw error;
  }
}

async function readMarkdown(path: string): Promise<string | AssertionResult> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = filesystemCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
      return failure(`unable to read Markdown file: ${code}`);
    }
    throw error;
  }
}

function mismatches(candidate: Candidate, config: NormalizedConfig): string[] {
  const foundLabels = new Set(candidate.parsed.labels.map(normalizeLabel));
  const out = config.labels
    .filter((label) => !foundLabels.has(label))
    .map((label) => `missing label #${label}`);

  if (config.status !== undefined && candidate.parsed.status !== config.status) {
    out.push(`status expected ${config.status}, found ${candidate.parsed.status}`);
  }
  if (config.due !== undefined && candidate.parsed.due !== config.due) {
    out.push(`due expected ${config.due}, found ${candidate.parsed.due ?? "none"}`);
  }
  if (config.priority !== undefined && candidate.parsed.priority !== config.priority) {
    out.push(`priority expected ${config.priority}, found ${candidate.parsed.priority}`);
  }
  return out;
}

export default async function todoMarkdown(_output: string, context: Context): Promise<AssertionResult> {
  const config = normalizeConfig(context.config);
  if ("pass" in config) return config;

  const containerPath = context.providerResponse?.metadata?.containerPath;
  if (typeof containerPath !== "string" || containerPath.trim().length === 0) {
    return failure("missing containerPath in metadata");
  }

  const containerState = await directoryState(containerPath);
  if (containerState === "missing") return failure("container path not found");
  if (containerState === "unreadable") return failure("container path is not readable");
  if (containerState !== "directory") return failure("containerPath is not a directory");

  const modulePath = join(containerPath, ...config.moduleParts);
  const moduleState = await directoryState(modulePath);
  if (moduleState === "missing") return failure(`module path not found: "${config.module}"`);
  if (moduleState === "unreadable") return failure(`module path is not readable: "${config.module}"`);
  if (moduleState !== "directory") return failure(`module path is not a directory: "${config.module}"`);

  const files = await walkFiles(modulePath, (name) => name.toLowerCase().endsWith(".md"));
  const candidates: Candidate[] = [];

  for (const path of files) {
    const contents = await readMarkdown(join(modulePath, path));
    if (typeof contents !== "string") return contents;
    const lines = contents.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index++) {
      const parsed = parseTodoLine(lines[index] ?? "");
      if (!parsed || !parsed.text.toLowerCase().includes(config.text)) continue;
      candidates.push({ path, line: index + 1, parsed });
    }
  }

  if (candidates.length === 0) {
    return failure(`no todo text match for "${config.text}" in module "${config.module}"`);
  }

  const evaluated = candidates.map((candidate) => ({
    candidate,
    mismatches: mismatches(candidate, config),
  }));
  const match = evaluated.find((entry) => entry.mismatches.length === 0);
  if (match) {
    return {
      pass: true,
      score: 1,
      reason: `matched todo at ${match.candidate.path}:${match.candidate.line}`,
    };
  }

  const details = evaluated
    .map(({ candidate, mismatches: values }) => `${candidate.path}:${candidate.line} [${values.join("; ")}]`)
    .join(" | ");
  return failure(`matching todo text found, but fields mismatched: ${details}`);
}
