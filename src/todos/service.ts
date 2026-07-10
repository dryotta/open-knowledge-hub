import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContainerService } from "../container/service.js";
import { OkhError } from "../errors.js";
import { walkFiles } from "../modules/fs.js";
import { Mutex } from "../util/mutex.js";
import { parseTodoLine } from "./parser.js";
import { filterTodos, sortTodos } from "./query.js";
import type { TodoListResult, TodoLocator, TodoQuery, TodoRecord, TodoSource, TodoWarning } from "./types.js";

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

function assertIsoCalendarDate(value: string, field: "dueAfter" | "dueBefore"): void {
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

function encodeRef(locator: TodoLocator): string {
  return Buffer.from(JSON.stringify(locator), "utf8").toString("base64url");
}

function makeSource(container: string, module: string, path: string, line: number): TodoSource {
  return { container, module, path, line };
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
            const locator: TodoLocator = {
              v: 1,
              container: source.container,
              module: source.module,
              path: source.path,
              line: source.line,
              fingerprint: fingerprintLine(raw),
              ...(parsed.id ? { id: parsed.id } : {}),
            };

            tasks.push({
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
            });

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
}
