import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ContainerService, ResolvedContainer, ResolvedModule } from "../container/service.js";
import { OkhError } from "../errors.js";
import { walkFiles } from "../modules/fs.js";
import { Mutex } from "../util/mutex.js";
import { parseTodoLine } from "./parser.js";
import { filterTodos, sortTodos } from "./query.js";
import { createTodoLine, normalizeTodoLabel, patchTodoLine } from "./serializer.js";
import type {
  ParsedTodoLine,
  TodoLinePatch,
  TodoListResult,
  TodoLocator,
  TodoMutationInput,
  TodoMutationResult,
  TodoMutationPreview,
  TodoPriority,
  TodoQuery,
  TodoRecord,
  TodoSource,
  TodoWarning,
} from "./types.js";

type PreparedTodoMutation = {
  operation: TodoMutationInput["operation"];
  preview: TodoMutationPreview;
  apply: () => Promise<{ todo: TodoRecord; dirtyContainer: string }>;
};

function isIsoCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function assertIsoCalendarDate(value: string, field: string): void {
  if (!isIsoCalendarDate(value)) {
    throw new OkhError("INVALID_ARGUMENT", `${field} must be a valid YYYY-MM-DD calendar date.`);
  }
}

function utcToday(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function fingerprintLine(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

function isTodoPriority(value: string): value is TodoPriority {
  return ["lowest", "low", "normal", "medium", "high", "highest"].includes(value);
}

function encodeRef(locator: TodoLocator): string {
  return Buffer.from(JSON.stringify(locator), "utf8").toString("base64url");
}

function makeSource(container: string, module: string, path: string, line: number): TodoSource {
  return { container, module, path, line };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OkhError("INVALID_ARGUMENT", `${field} must be a non-empty string.`);
  }
  return value;
}

function wrapInvalidArgument(message: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof OkhError) throw err;
    throw new OkhError("INVALID_ARGUMENT", message);
  }
}

function assertTodoPriority(value: unknown, field: string): TodoPriority {
  if (typeof value !== "string" || !isTodoPriority(value)) {
    throw new OkhError("INVALID_ARGUMENT", `${field} must be a valid todo priority.`);
  }
  return value;
}

function normalizeLabels(labels: unknown): string[] {
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) {
    throw new OkhError("INVALID_ARGUMENT", "labels must be an array of valid todo labels.");
  }

  return labels.map((label) => {
    try {
      return normalizeTodoLabel(label);
    } catch {
      throw new OkhError("INVALID_ARGUMENT", "labels must be an array of valid todo labels.");
    }
  });
}

function decodeTodoRef(ref: string): TodoLocator {
  try {
    const raw = JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
    if (!isPlainObject(raw)) throw new Error("Invalid ref object.");

    const { v, container, module, path, line, fingerprint, id } = raw;

    if (
      v !== 1 ||
      typeof container !== "string" ||
      container.length === 0 ||
      typeof module !== "string" ||
      module.length === 0 ||
      typeof path !== "string" ||
      path.length === 0 ||
      typeof fingerprint !== "string" ||
      fingerprint.length === 0 ||
      typeof line !== "number" ||
      !Number.isInteger(line) ||
      line <= 0 ||
      (id !== undefined && (typeof id !== "string" || id.length === 0))
    ) {
      throw new Error("Invalid ref shape.");
    }

    return {
      v: 1,
      container,
      module,
      path,
      line,
      fingerprint,
      ...(id === undefined ? {} : { id }),
    };
  } catch {
    throw new OkhError("INVALID_ARGUMENT", "Invalid todo ref.");
  }
}

function toTodoRecord(
  container: string,
  module: string,
  path: string,
  line: number,
  raw: string,
  parsed: ParsedTodoLine,
): TodoRecord {
  const source = makeSource(container, module, path, line);
  const locator: TodoLocator = {
    v: 1,
    container: source.container,
    module: source.module,
    path: source.path,
    line: source.line,
    fingerprint: fingerprintLine(raw),
    ...(parsed.id ? { id: parsed.id } : {}),
  };

  return {
    ref: encodeRef(locator),
    status: parsed.status,
    statusChar: parsed.statusChar,
    readOnly: parsed.readOnly,
    text: parsed.text,
    labels: [...parsed.labels],
    priority: parsed.priority,
    due: parsed.due,
    created: parsed.created,
    completed: parsed.completed,
    id: parsed.id,
    warnings: [...parsed.warnings],
    source,
  };
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r\n|\n/u).length;
}

function inspectText(text: string): { newline: string; finalNewline: boolean; lines: string[] } {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = text.endsWith("\r\n") || text.endsWith("\n");
  if (text.length === 0) {
    return { newline, finalNewline: false, lines: [] };
  }

  const lines = text.split(/\r\n|\n/u);
  if (finalNewline) lines.pop();
  return { newline, finalNewline, lines };
}

function joinLines(lines: string[], newline: string, finalNewline: boolean): string {
  const body = lines.join(newline);
  return finalNewline ? `${body}${newline}` : body;
}

function buildEntryLines(timestamp: string, entrySummary: string | undefined, observation: string | undefined, todoLine: string): string[] {
  const heading = `### ${timestamp} — ${entrySummary && entrySummary.trim().length > 0 ? entrySummary.trim() : "Todo"}`;
  const trimmedObservation = observation?.trim();
  return trimmedObservation
    ? [heading, "", trimmedObservation, "", todoLine]
    : [heading, "", todoLine];
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function resolveTodoFile(moduleRoot: string, path: string): { absPath: string; relativePath: string } {
  const normalized = path.replace(/\\/gu, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    isAbsolute(path) ||
    !normalized.toLowerCase().endsWith(".md")
  ) {
    throw new OkhError("INVALID_ARGUMENT", "Invalid todo ref.");
  }

  const absPath = resolve(moduleRoot, path);
  if (!isPathWithin(moduleRoot, absPath)) {
    throw new OkhError("INVALID_ARGUMENT", "Invalid todo ref.");
  }

  const relativePath = relative(moduleRoot, absPath).replace(/\\/gu, "/");
  if (relativePath !== normalized) {
    throw new OkhError("INVALID_ARGUMENT", "Invalid todo ref.");
  }

  return { absPath, relativePath };
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, contents, "utf8");
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function validateQuery(query: TodoQuery): void {
  if (query.dueAfter) assertIsoCalendarDate(query.dueAfter, "dueAfter");
  if (query.dueBefore) assertIsoCalendarDate(query.dueBefore, "dueBefore");
  if (query.dueAfter && query.dueBefore && query.dueAfter > query.dueBefore) {
    throw new OkhError("INVALID_ARGUMENT", "dueAfter must be on or before dueBefore.");
  }
}

export class TodoService {
  private readonly mutex = new Mutex();

  constructor(
    private readonly containers: ContainerService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async mutate(input: TodoMutationInput): Promise<TodoMutationResult> {
    return this.mutex.run(() => this.executeMutation(input));
  }

  async list(query: TodoQuery = {}): Promise<TodoListResult> {
    void this.mutex;
    validateQuery(query);

    const targets = await this.containers.resolveTargets(query.container, query.module);
    const tasks: TodoRecord[] = [];
    const warnings: TodoWarning[] = [];

    for (const container of targets) {
      for (const module of container.modules) {
        if (module.type !== "memory") continue;

        const files = await walkFiles(module.absPath, (name) => name.toLowerCase().endsWith(".md"));
        for (const path of files) {
          const text = await readFile(join(module.absPath, path), "utf8");
          const lines = text.split(/\r?\n/u);

          for (let index = 0; index < lines.length; index++) {
            const raw = lines[index] ?? "";
            const parsed = parseTodoLine(raw);
            if (!parsed) continue;

            const line = index + 1;
            const source = makeSource(container.name, module.path, path, line);
            tasks.push(toTodoRecord(container.name, module.path, path, line, raw, parsed));

            for (const message of parsed.warnings) {
              warnings.push({ source, message });
            }
          }
        }
      }
    }

    const today = utcToday(this.now());
    const filtered = filterTodos(tasks, query, today);
    const sorted = sortTodos(filtered, today);

    return {
      tasks: sorted,
      warnings,
      counts: {
        total: filtered.length,
        open: filtered.filter((task) => task.status === "open").length,
        completed: filtered.filter((task) => task.status === "completed").length,
        custom: filtered.filter((task) => task.status === "custom").length,
      },
    };
  }

  private async resolveMemoryModule(containerName: string, modulePath: string): Promise<{ container: ResolvedContainer; module: ResolvedModule }> {
    const targets = await this.containers.resolveTargets(containerName, modulePath);
    const container = targets[0];
    const module = container?.modules[0];

    if (!container || !module) {
      throw new OkhError("NOT_FOUND", `Container "${containerName}" has no module "${modulePath}".`);
    }
    if (module.type !== "memory") {
      throw new OkhError("INVALID_ARGUMENT", `Module "${modulePath}" is not a memory module.`);
    }

    return { container, module };
  }

  private async executeMutation(input: TodoMutationInput): Promise<TodoMutationResult> {
    const prepared = input.operation === "create"
      ? await this.prepareCreate(input)
      : await this.prepareUpdate(input);

    if (input.apply !== true) {
      return {
        operation: prepared.operation,
        applied: false,
        preview: prepared.preview,
        needsConfirmation: true,
      };
    }

    const applied = await prepared.apply();
    return {
      operation: prepared.operation,
      applied: true,
      ...applied,
    };
  }

  private async prepareCreate(input: Extract<TodoMutationInput, { operation: "create" }>): Promise<PreparedTodoMutation> {
    const containerName = assertNonEmptyString(input.container, "container");
    const modulePath = assertNonEmptyString(input.module, "module");
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (text.length === 0) {
      throw new OkhError("INVALID_ARGUMENT", "text must be a non-blank string.");
    }
    if (input.due !== undefined) {
      wrapInvalidArgument("due must be a valid YYYY-MM-DD calendar date.", () => assertIsoCalendarDate(input.due!, "due"));
    }

    const labels = input.labels === undefined ? [] : normalizeLabels(input.labels);
    const priority = input.priority === undefined ? undefined : assertTodoPriority(input.priority, "priority");
    if (input.entrySummary !== undefined && typeof input.entrySummary !== "string") {
      throw new OkhError("INVALID_ARGUMENT", "entrySummary must be a string when provided.");
    }
    if (input.observation !== undefined && typeof input.observation !== "string") {
      throw new OkhError("INVALID_ARGUMENT", "observation must be a string when provided.");
    }

    const now = this.now();
    const timestamp = now.toISOString();
    const today = timestamp.slice(0, 10);
    const { container, module } = await this.resolveMemoryModule(containerName, modulePath);
    const targetPath = join(module.absPath, `${today}.md`);
    const existing = await readFile(targetPath, "utf8").catch((err: unknown) => {
      if (typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw err;
    });
    const { newline, finalNewline, lines } = inspectText(existing);

    const todoLine = wrapCreateTodoLine({
      text,
      labels: labels.length > 0 ? labels : ["general"],
      priority,
      due: input.due,
      created: today,
    });
    const entryLines = buildEntryLines(timestamp, input.entrySummary, input.observation, todoLine);
    const todoLineOffset = entryLines.indexOf(todoLine) + 1;

    let createdLine = todoLineOffset;
    let nextLines = entryLines;
    let nextFinalNewline = true;

    if (lines.length > 0) {
      const trimmedLines = [...lines];
      while (trimmedLines[trimmedLines.length - 1] === "") trimmedLines.pop();
      nextLines = [...trimmedLines, "", ...entryLines];
      createdLine = countLines(trimmedLines.join(newline)) + 1 + todoLineOffset;
      nextFinalNewline = finalNewline;
    }

    const parsed = parseTodoLine(todoLine);
    if (!parsed) {
      throw new OkhError("INVALID_ARGUMENT", "Failed to create todo.");
    }

    const todo = toTodoRecord(container.name, module.path, `${today}.md`, createdLine, todoLine, parsed);
    return {
      operation: "create",
      preview: {
        line: todoLine,
        source: todo.source,
        todo,
      },
      apply: async () => {
        await mkdir(module.absPath, { recursive: true });
        await atomicWrite(targetPath, joinLines(nextLines, newline, nextFinalNewline));
        return {
          todo,
          dirtyContainer: container.name,
        };
      },
    };
  }

  private async prepareUpdate(input: Extract<TodoMutationInput, { operation: "update" }>): Promise<PreparedTodoMutation> {
    const locator = decodeTodoRef(input.ref);
    const { container, module } = await this.resolveMemoryModule(locator.container, locator.module);
    const { absPath, relativePath } = resolveTodoFile(module.absPath, locator.path);

    let text: string;
    try {
      text = await readFile(absPath, "utf8");
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new OkhError("CONFLICT", "Todo ref is stale.");
      }
      throw err;
    }
    const listedFiles = await walkFiles(module.absPath, (name) => name.toLowerCase().endsWith(".md"));
    if (!listedFiles.includes(relativePath)) {
      throw new OkhError("INVALID_ARGUMENT", "Invalid todo ref.");
    }

    const { newline, finalNewline, lines } = inspectText(text);
    const physicalTodos = lines.flatMap((raw, index) => {
      const parsed = parseTodoLine(raw);
      return parsed
        ? [{
            line: index + 1,
            index,
            raw,
            parsed,
            fingerprint: fingerprintLine(raw),
          }]
        : [];
    });

    const target = this.resolveUpdateTarget(locator, lines, physicalTodos);
    if (target.parsed.readOnly) {
      throw new OkhError("INVALID_ARGUMENT", "Cannot update read-only todo statuses.");
    }

    const patch: TodoLinePatch = {};
    if (input.completed !== undefined) {
      if (typeof input.completed !== "boolean") {
        throw new OkhError("INVALID_ARGUMENT", "completed must be a boolean when provided.");
      }
      patch.completed = input.completed;
    }
    if (input.labels !== undefined) {
      patch.labels = normalizeLabels(input.labels);
    }
    if (input.due !== undefined) {
      if (input.due !== null && typeof input.due !== "string") {
        throw new OkhError("INVALID_ARGUMENT", "due must be null or a valid YYYY-MM-DD calendar date.");
      }
      if (typeof input.due === "string") {
        wrapInvalidArgument("due must be a valid YYYY-MM-DD calendar date.", () => assertIsoCalendarDate(input.due!, "due"));
      }
      patch.due = input.due;
    }
    if (input.priority !== undefined) {
      if (input.priority !== null && !isTodoPriority(String(input.priority))) {
        throw new OkhError("INVALID_ARGUMENT", "priority must be a valid todo priority or null.");
      }
      patch.priority = input.priority === null ? null : assertTodoPriority(input.priority, "priority");
    }
    if (Object.keys(patch).length === 0) {
      throw new OkhError("INVALID_ARGUMENT", "Todo update cannot be empty.");
    }

    const today = utcToday(this.now());
    let nextRaw: string;
    try {
      nextRaw = patchTodoLine(target.parsed, patch, today);
    } catch (err) {
      if (err instanceof OkhError) throw err;
      throw new OkhError("INVALID_ARGUMENT", err instanceof Error ? err.message : "Invalid todo update.");
    }

    const parsed = parseTodoLine(nextRaw);
    if (!parsed) {
      throw new OkhError("CONFLICT", "Updated todo could not be reparsed.");
    }

    const nextLines = [...lines];
    nextLines[target.index] = nextRaw;
    const todo = toTodoRecord(container.name, module.path, relativePath, target.line, nextRaw, parsed);

    return {
      operation: "update",
      preview: {
        line: nextRaw,
        source: todo.source,
        todo,
      },
      apply: async () => {
        await atomicWrite(absPath, joinLines(nextLines, newline, finalNewline));
        return {
          todo,
          dirtyContainer: container.name,
        };
      },
    };
  }

  private resolveUpdateTarget(
    locator: TodoLocator,
    lines: string[],
    todos: Array<{ line: number; index: number; raw: string; parsed: ParsedTodoLine; fingerprint: string }>,
  ): { line: number; index: number; raw: string; parsed: ParsedTodoLine; fingerprint: string } {
    if (locator.id) {
      const idMatches = todos.filter((todo) => todo.parsed.id === locator.id);
      if (idMatches.length > 1) {
        throw new OkhError("CONFLICT", "Todo ref matches multiple IDs.");
      }
      if (idMatches.length === 1) {
        return idMatches[0]!;
      }

      if (locator.line <= lines.length || todos.some((todo) => todo.fingerprint === locator.fingerprint)) {
        throw new OkhError("CONFLICT", "Todo ref is stale.");
      }
      throw new OkhError("NOT_FOUND", "Todo not found.");
    }

    const lineMatch = todos.find((todo) => todo.line === locator.line && todo.fingerprint === locator.fingerprint);
    if (lineMatch) {
      return lineMatch;
    }

    const fingerprintMatches = todos.filter((todo) => todo.fingerprint === locator.fingerprint);
    if (fingerprintMatches.length > 1) {
      throw new OkhError("CONFLICT", "Todo ref matches multiple tasks.");
    }
    if (fingerprintMatches.length === 1) {
      return fingerprintMatches[0]!;
    }

    throw new OkhError("CONFLICT", "Todo ref is stale.");
  }
}

function wrapCreateTodoLine(input: { text: string; labels: string[]; priority?: TodoPriority; due?: string; created: string }): string {
  try {
    return createTodoLine(input);
  } catch (err) {
    throw new OkhError("INVALID_ARGUMENT", err instanceof Error ? err.message : "Invalid todo input.");
  }
}
