# Memory Todo Lists and MCP App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Obsidian-compatible todos to memory Markdown, deterministic todo tools, a management skill, and an interactive MCP App.

**Architecture:** A pure parser/serializer owns the Markdown contract; `TodoService` scans memory modules and performs optimistic, atomic mutations. Two MCP tools expose the service, while a bundled MCP App consumes structured results and calls the mutation tool. Skills keep natural-language reasoning in the client agent.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Zod, Vitest, `@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps@1.1.2`, esbuild, promptfoo/Copilot CLI evals.

---

## File map

### Todo domain

- Create `src/todos/types.ts` — shared normalized todo, query, warning, locator, and update types.
- Create `src/todos/parser.ts` — tolerant one-line checkbox parser and metadata tokenization.
- Create `src/todos/serializer.ts` — targeted status/label/due/priority edits that preserve unrelated Markdown.
- Create `src/todos/query.ts` — pure filtering and deterministic sorting shared by server and app.
- Create `src/todos/service.ts` — memory-module scanning, opaque refs, creation, optimistic mutation, and atomic writes.
- Modify `src/errors.ts` — add a conflict error for stale or ambiguous edits.

### MCP server

- Create `src/server/toolSupport.ts` — shared tool metadata/result/error wrappers moved from `tools.ts`.
- Create `src/server/todoTools.ts` — `todos`, `update_todo`, text fallback, structured results, and app resource registration.
- Modify `src/server/tools.ts` — use shared support and register todo tools.
- Modify `src/server/index.ts` — construct/inject `TodoService`.
- Modify `src/server/toolSchemas.ts` — add todo tool schemas.
- Create `resources/tool-meta/todos.md` and `resources/tool-meta/update_todo.md`.
- Modify `resources/prompts/instructions.md` — route todo-list requests to `todos`.

### Skills

- Modify `resources/module-types/memory/skills/remember/SKILL.md` — identify explicit tracked actions and call `update_todo`.
- Create `resources/module-types/memory/skills/todo/SKILL.md` — add, complete/reopen, relabel, due-date, and priority workflow.

### MCP App

- Create `app/todos/index.html` — app shell and styles.
- Create `app/todos/model.ts` — app state/filter adapters.
- Create `app/todos/main.ts` — MCP Apps bridge, rendering, filters, and status updates.
- Create `scripts/build-todo-app.mjs` — esbuild single-file HTML bundler.
- Create `tsconfig.app.json` — DOM-aware app typecheck.
- Modify `package.json` and `package-lock.json` — compatible SDK/build dependencies and scripts.

### Tests, evals, and docs

- Create `test/todo-parser.test.ts`.
- Create `test/todo-serializer.test.ts`.
- Create `test/todo-query.test.ts`.
- Create `test/todo-service.test.ts`.
- Create `test/todo-app.test.ts`.
- Modify `test/server.test.ts`, `test/skills.test.ts`, `test/run.test.ts`, and `test/prompts.test.ts`.
- Modify `eval/fixtures/kb-hub/mem/2026-02-15.md`.
- Create `eval/assertions/todo-markdown.ts`.
- Create `eval-test/assertions/todo-markdown.test.ts`.
- Create `eval/scenarios/todos/show.yaml`, `eval/scenarios/remember/todo.yaml`, and `eval/scenarios/todo/complete.yaml`.
- Modify `eval/README.md` — remove the stale fixed scenario count after adding todo evals.
- Modify `README.md` and `CONTEXT.md`.

---

### Task 1: Define the todo domain and tolerant parser

**Files:**
- Create: `src/todos/types.ts`
- Create: `src/todos/parser.ts`
- Create: `test/todo-parser.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `test/todo-parser.test.ts` with these cases:

```ts
import { describe, expect, it } from "vitest";
import { parseTodoLine } from "../src/todos/parser.js";

describe("parseTodoLine", () => {
  it("parses a bare checkbox with every optional field absent", () => {
    expect(parseTodoLine("- [ ] Buy milk")).toMatchObject({
      status: "open",
      statusChar: " ",
      text: "Buy milk",
      labels: [],
      priority: "normal",
      warnings: [],
    });
  });

  it("parses Obsidian tags, priority, dates, and an existing id in any order", () => {
    const parsed = parseTodoLine(
      "- [x] Ship release ✅ 2026-07-12 #todo #work 🆔 rel-7 📅 2026-07-11 ⏫ ➕ 2026-07-10",
    );
    expect(parsed).toMatchObject({
      status: "completed",
      text: "Ship release",
      labels: ["work"],
      priority: "high",
      due: "2026-07-11",
      created: "2026-07-10",
      completed: "2026-07-12",
      id: "rel-7",
    });
  });

  it("recognizes ordered checkboxes and exposes custom statuses as read-only", () => {
    expect(parseTodoLine("12. [/] Investigate #work")).toMatchObject({
      status: "custom",
      statusChar: "/",
      readOnly: true,
      text: "Investigate",
      labels: ["work"],
    });
  });

  it("keeps malformed metadata visible and reports warnings", () => {
    const parsed = parseTodoLine("- [ ] File taxes 📅 someday 🔼");
    expect(parsed?.text).toBe("File taxes");
    expect(parsed?.due).toBeUndefined();
    expect(parsed?.priority).toBe("medium");
    expect(parsed?.warnings).toContain('Invalid due date "someday".');
  });

  it("returns undefined for ordinary prose", () => {
    expect(parseTodoLine("Remember to buy milk.")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the parser test and confirm failure**

Run:

```powershell
npx vitest run test/todo-parser.test.ts
```

Expected: FAIL because `src/todos/parser.ts` does not exist.

- [ ] **Step 3: Add shared todo types**

Create `src/todos/types.ts` with the public contracts used by parser, service,
tools, and app:

```ts
export const TODO_PRIORITIES = ["lowest", "low", "normal", "medium", "high", "highest"] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];
export type TodoStatus = "open" | "completed" | "custom";

export type TodoTokenKind = "label" | "priority" | "due" | "created" | "completed" | "id";

export interface TodoToken {
  kind: TodoTokenKind;
  start: number;
  end: number;
  raw: string;
  value?: string;
  valid: boolean;
}

export interface ParsedTodoLine {
  raw: string;
  prefix: string;
  statusIndex: number;
  statusChar: string;
  status: TodoStatus;
  readOnly: boolean;
  body: string;
  text: string;
  labels: string[];
  priority: TodoPriority;
  due?: string;
  created?: string;
  completed?: string;
  id?: string;
  warnings: string[];
  tokens: TodoToken[];
}

export interface TodoSource {
  container: string;
  module: string;
  path: string;
  line: number;
}

export interface TodoRecord {
  ref: string;
  status: TodoStatus;
  statusChar: string;
  readOnly: boolean;
  text: string;
  labels: string[];
  priority: TodoPriority;
  due?: string;
  created?: string;
  completed?: string;
  id?: string;
  warnings: string[];
  source: TodoSource;
}

export interface TodoWarning {
  source: TodoSource;
  message: string;
}

export interface TodoListResult {
  tasks: TodoRecord[];
  warnings: TodoWarning[];
  counts: { total: number; open: number; completed: number; custom: number };
}
```

- [ ] **Step 4: Implement the tolerant parser**

Create `src/todos/parser.ts`. Use one regex for list/checkbox structure, collect
metadata spans from the checkbox body, and remove only recognized metadata from
the display text.

Core constants and behavior:

```ts
import type {
  ParsedTodoLine,
  TodoPriority,
  TodoStatus,
  TodoToken,
  TodoTokenKind,
} from "./types.js";

const CHECKBOX = /^(\s*(?:(?:[-+*])|(?:\d+[.)]))\s+\[)(.)(\]\s+)(.*)$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

const PRIORITY_BY_EMOJI: Record<string, TodoPriority> = {
  "⏬": "lowest",
  "🔽": "low",
  "🔼": "medium",
  "⏫": "high",
  "🔺": "highest",
};

function statusOf(char: string): { status: TodoStatus; readOnly: boolean } {
  if (char === " ") return { status: "open", readOnly: false };
  if (char === "x" || char === "X") return { status: "completed", readOnly: false };
  return { status: "custom", readOnly: true };
}

function pushToken(
  tokens: TodoToken[],
  kind: TodoTokenKind,
  match: RegExpExecArray,
  raw: string,
  value: string | undefined,
  valid: boolean,
): void {
  tokens.push({
    kind,
    start: match.index,
    end: match.index + raw.length,
    raw,
    ...(value === undefined ? {} : { value }),
    valid,
  });
}
```

Implement `parseTodoLine(raw)` so it:

1. returns `undefined` when `CHECKBOX` does not match;
2. records `prefix`, `statusIndex`, `statusChar`, and `body`;
3. tokenizes tags with `/(^|\s)(#[\p{L}\p{N}_/-]+)/gu`, excluding `#todo`
   from normalized labels;
4. tokenizes priority emojis and chooses the last recognized priority;
5. tokenizes `📅`, `➕`, and `✅` followed by one non-whitespace value, accepting
   only `YYYY-MM-DD` and warning otherwise;
6. tokenizes `🆔` followed by one non-whitespace value;
7. warns on duplicate known fields but keeps the last valid value;
8. derives display text by removing token spans from the body, preserving unknown
   Markdown, trimming boundaries, and collapsing only whitespace introduced by
   removed spans.

Export:

```ts
export function parseTodoLine(raw: string): ParsedTodoLine | undefined;
```

- [ ] **Step 5: Run parser tests**

Run:

```powershell
npx vitest run test/todo-parser.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 6: Commit the parser**

```powershell
git add src\todos\types.ts src\todos\parser.ts test\todo-parser.test.ts
git commit -m "feat(todos): parse Obsidian-compatible memory tasks"
```

---

### Task 2: Add targeted todo serialization

**Files:**
- Create: `src/todos/serializer.ts`
- Create: `test/todo-serializer.test.ts`
- Modify: `src/todos/types.ts`

- [ ] **Step 1: Write failing serializer tests**

Create `test/todo-serializer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseTodoLine } from "../src/todos/parser.js";
import { createTodoLine, patchTodoLine } from "../src/todos/serializer.js";

describe("todo serializer", () => {
  it("creates canonical OKH tasks without an automatic id", () => {
    expect(createTodoLine({
      text: "Buy milk",
      labels: ["shopping"],
      priority: "medium",
      due: "2026-07-11",
      created: "2026-07-10",
    })).toBe("- [ ] Buy milk #todo #shopping 🔼 📅 2026-07-11 ➕ 2026-07-10");
  });

  it("completes and reopens while preserving unrelated syntax", () => {
    const original = parseTodoLine("- [ ] Ship **release** #todo #work 🔁 every week 🆔 rel-7")!;
    const done = patchTodoLine(original, { completed: true }, "2026-07-12");
    expect(done).toBe("- [x] Ship **release** #todo #work 🔁 every week ✅ 2026-07-12 🆔 rel-7");

    const reopened = patchTodoLine(parseTodoLine(done)!, { completed: false }, "2026-07-13");
    expect(reopened).toBe("- [ ] Ship **release** #todo #work 🔁 every week 🆔 rel-7");
  });

  it("replaces category labels but preserves the #todo marker", () => {
    const parsed = parseTodoLine("- [ ] Call Alice #todo #work #private 📅 2026-07-20")!;
    expect(patchTodoLine(parsed, { labels: ["phone"] }, "2026-07-10"))
      .toBe("- [ ] Call Alice #todo #phone 📅 2026-07-20");
  });

  it("sets and clears due date and priority independently", () => {
    const parsed = parseTodoLine("- [ ] File taxes #todo #private ➕ 2026-07-10")!;
    const set = patchTodoLine(parsed, { due: "2026-07-31", priority: "highest" }, "2026-07-10");
    expect(set).toBe("- [ ] File taxes #todo #private 🔺 📅 2026-07-31 ➕ 2026-07-10");
    expect(patchTodoLine(parseTodoLine(set)!, { due: null, priority: null }, "2026-07-10"))
      .toBe("- [ ] File taxes #todo #private ➕ 2026-07-10");
  });
});
```

- [ ] **Step 2: Run the serializer test and confirm failure**

```powershell
npx vitest run test/todo-serializer.test.ts
```

Expected: FAIL because `serializer.ts` does not exist.

- [ ] **Step 3: Add patch/create types**

Append to `src/todos/types.ts`:

```ts
export interface CreateTodoLineInput {
  text: string;
  labels: string[];
  priority?: TodoPriority;
  due?: string;
  created: string;
}

export interface TodoLinePatch {
  completed?: boolean;
  labels?: string[];
  due?: string | null;
  priority?: TodoPriority | null;
}
```

- [ ] **Step 4: Implement canonical creation and span-based patching**

Create `src/todos/serializer.ts` with:

```ts
import type {
  CreateTodoLineInput,
  ParsedTodoLine,
  TodoLinePatch,
  TodoPriority,
  TodoToken,
  TodoTokenKind,
} from "./types.js";

const PRIORITY_EMOJI: Record<Exclude<TodoPriority, "normal">, string> = {
  lowest: "⏬",
  low: "🔽",
  medium: "🔼",
  high: "⏫",
  highest: "🔺",
};

export function normalizeTodoLabel(label: string): string {
  const bare = label.trim().replace(/^#/, "").toLowerCase();
  if (!/^[\p{L}\p{N}_/-]+$/u.test(bare)) throw new Error(`Invalid todo label "${label}".`);
  return bare;
}

function renderPriority(priority: TodoPriority | null | undefined): string | undefined {
  return priority && priority !== "normal" ? PRIORITY_EMOJI[priority] : undefined;
}

export function createTodoLine(input: CreateTodoLineInput): string {
  const labels = [...new Set(input.labels.map(normalizeTodoLabel))];
  const parts = [
    `- [ ] ${input.text.trim()}`,
    "#todo",
    ...labels.map((label) => `#${label}`),
    renderPriority(input.priority),
    input.due ? `📅 ${input.due}` : undefined,
    `➕ ${input.created}`,
  ].filter((value): value is string => Boolean(value));
  return parts.join(" ");
}
```

Implement patching with these exact rules:

- status changes replace only the checkbox character;
- category-label changes remove every `label` token, preserve any raw `#todo`,
  and insert normalized labels immediately after `#todo` or before the first
  non-label metadata token;
- priority changes remove every priority token and insert the replacement before
  due/created/completed/id;
- due changes remove every due token and insert the replacement before
  created/completed/id;
- completion changes remove every completion-date token and insert one before an
  existing ID;
- removals include one adjacent separator space, not arbitrary internal spaces;
- unchanged token kinds retain their original raw spelling and position.

Use helpers with these signatures:

```ts
function removeTokens(body: string, tokens: TodoToken[]): string;
function insertBeforeKinds(
  body: string,
  parsed: ParsedTodoLine,
  value: string,
  kinds: TodoTokenKind[],
): string;

export function patchTodoLine(
  parsed: ParsedTodoLine,
  patch: TodoLinePatch,
  today: string,
): string;
```

Reject an empty patch and attempts to mutate `parsed.readOnly`.

- [ ] **Step 5: Run parser and serializer tests**

```powershell
npx vitest run test/todo-parser.test.ts test/todo-serializer.test.ts
```

Expected: 9 tests PASS.

- [ ] **Step 6: Commit serialization**

```powershell
git add src\todos\types.ts src\todos\serializer.ts test\todo-serializer.test.ts
git commit -m "feat(todos): serialize targeted task updates"
```

---

### Task 3: Add filtering, sorting, scanning, and opaque refs

**Files:**
- Create: `src/todos/query.ts`
- Create: `src/todos/service.ts`
- Create: `test/todo-query.test.ts`
- Create: `test/todo-service.test.ts`
- Modify: `src/todos/types.ts`

- [ ] **Step 1: Write failing query tests**

Create `test/todo-query.test.ts` with fixed records that prove:

```ts
import { describe, expect, it } from "vitest";
import { filterTodos, sortTodos } from "../src/todos/query.js";
import type { TodoRecord } from "../src/todos/types.js";

const source = { container: "hub", module: "mem", path: "2026-07-10.md", line: 1 };
const task = (overrides: Partial<TodoRecord>): TodoRecord => ({
  ref: "r",
  status: "open",
  statusChar: " ",
  readOnly: false,
  text: "Task",
  labels: [],
  priority: "normal",
  warnings: [],
  source,
  ...overrides,
});

describe("todo query", () => {
  it("filters by all selected labels, status, priority, due range, and text", () => {
    const tasks = [
      task({ text: "Buy milk", labels: ["shopping", "private"], priority: "high", due: "2026-07-11" }),
      task({ text: "Write report", labels: ["work"], priority: "medium", due: "2026-07-20" }),
    ];
    expect(filterTodos(tasks, {
      status: "open",
      labels: ["shopping", "private"],
      labelMode: "all",
      priorities: ["high"],
      dueBefore: "2026-07-12",
      query: "milk",
    }, "2026-07-10").map((todo) => todo.text)).toEqual(["Buy milk"]);
  });

  it("sorts overdue, nearest due, priority, created date, then source", () => {
    const tasks = [
      task({ ref: "later", due: "2026-07-12", priority: "highest" }),
      task({ ref: "overdue", due: "2026-07-09", priority: "low" }),
      task({ ref: "near", due: "2026-07-11", priority: "medium" }),
    ];
    expect(sortTodos(tasks, "2026-07-10").map((todo) => todo.ref))
      .toEqual(["overdue", "near", "later"]);
  });
});
```

- [ ] **Step 2: Write failing scan/service tests**

Create the first `test/todo-service.test.ts` cases:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { TodoService } from "../src/todos/service.js";
import { makePaths, makeTempDir, writeModule } from "./helpers.js";

const cleanups: string[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function setup() {
  const home = await makeTempDir(); cleanups.push(home);
  const root = await makeTempDir(); cleanups.push(root);
  const containers = new ContainerService(makePaths(home));
  await containers.addContainer({ source: root, name: "hub", create: true });
  await writeModule(root, "mem", { type: "memory", name: "Memory" });
  await writeModule(root, "kb", { type: "knowledge", name: "Knowledge" });
  return { root, todos: new TodoService(containers, () => new Date("2026-07-10T12:00:00Z")) };
}

describe("TodoService.list", () => {
  it("recursively scans only memory markdown and returns source-aware refs", async () => {
    const { root, todos } = await setup();
    await mkdir(join(root, "mem", "nested"), { recursive: true });
    await writeFile(join(root, "mem", "nested", "tasks.md"), "- [ ] Buy milk #shopping\n", "utf8");
    await writeFile(join(root, "kb", "ignored.md"), "- [ ] Ignore me\n", "utf8");

    const result = await todos.list();
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      text: "Buy milk",
      labels: ["shopping"],
      source: { container: "hub", module: "mem", path: "nested/tasks.md", line: 1 },
    });
    expect(result.tasks[0]!.ref.length).toBeGreaterThan(10);
  });
});
```

- [ ] **Step 3: Run query/service tests and confirm failure**

```powershell
npx vitest run test/todo-query.test.ts test/todo-service.test.ts
```

Expected: FAIL because query/service files do not exist.

- [ ] **Step 4: Add query, locator, and service input types**

Append to `src/todos/types.ts`:

```ts
export interface TodoQuery {
  container?: string;
  module?: string;
  status?: TodoStatus | "all";
  labels?: string[];
  labelMode?: "any" | "all";
  priorities?: TodoPriority[];
  dueAfter?: string;
  dueBefore?: string;
  overdue?: boolean;
  query?: string;
}

export interface TodoLocator {
  v: 1;
  container: string;
  module: string;
  path: string;
  line: number;
  fingerprint: string;
  id?: string;
}
```

- [ ] **Step 5: Implement pure filtering and sorting**

Create `src/todos/query.ts`:

```ts
import type { TodoPriority, TodoQuery, TodoRecord } from "./types.js";

const PRIORITY_RANK: Record<TodoPriority, number> = {
  lowest: 0,
  low: 1,
  normal: 2,
  medium: 3,
  high: 4,
  highest: 5,
};

export function filterTodos(tasks: TodoRecord[], query: TodoQuery, today: string): TodoRecord[] {
  const labels = (query.labels ?? []).map((label) => label.replace(/^#/, "").toLowerCase());
  const needle = query.query?.trim().toLowerCase();
  return tasks.filter((todo) => {
    if (query.status && query.status !== "all" && todo.status !== query.status) return false;
    if (query.priorities?.length && !query.priorities.includes(todo.priority)) return false;
    if (query.dueAfter && (!todo.due || todo.due < query.dueAfter)) return false;
    if (query.dueBefore && (!todo.due || todo.due > query.dueBefore)) return false;
    if (query.overdue && (!todo.due || todo.due >= today || todo.status === "completed")) return false;
    if (needle && !`${todo.text} ${todo.labels.join(" ")}`.toLowerCase().includes(needle)) return false;
    if (labels.length) {
      const own = new Set(todo.labels.map((label) => label.toLowerCase()));
      const matches = labels.map((label) => own.has(label));
      if ((query.labelMode ?? "any") === "all" ? matches.some((value) => !value) : matches.every((value) => !value)) {
        return false;
      }
    }
    return true;
  });
}

export function sortTodos(tasks: TodoRecord[], today: string): TodoRecord[] {
  return [...tasks].sort((a, b) => {
    const aOverdue = a.status === "open" && Boolean(a.due && a.due < today);
    const bOverdue = b.status === "open" && Boolean(b.due && b.due < today);
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
    if (a.due !== b.due) return (a.due ?? "9999-12-31").localeCompare(b.due ?? "9999-12-31");
    if (a.priority !== b.priority) return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (a.created !== b.created) return (b.created ?? "").localeCompare(a.created ?? "");
    return `${a.source.container}/${a.source.module}/${a.source.path}/${a.source.line}`
      .localeCompare(`${b.source.container}/${b.source.module}/${b.source.path}/${b.source.line}`);
  });
}
```

- [ ] **Step 6: Implement scanning and opaque refs**

Create `src/todos/service.ts` with constructor:

```ts
export class TodoService {
  private readonly mutex = new Mutex();

  constructor(
    private readonly containers: ContainerService,
    private readonly now: () => Date = () => new Date(),
  ) {}
}
```

Implement:

```ts
async list(query: TodoQuery = {}): Promise<TodoListResult>;
```

The method must:

1. call `containers.resolveTargets(query.container, query.module)`;
2. retain only `module.type === "memory"`;
3. use existing `walkFiles(module.absPath, (name) => name.toLowerCase().endsWith(".md"))`;
4. read files as UTF-8 and parse each physical line;
5. create a SHA-256 fingerprint of the exact line;
6. encode `TodoLocator` as base64url JSON;
7. collect parse warnings with source coordinates;
8. apply `filterTodos` and `sortTodos`;
9. calculate counts from the filtered result.

Before scanning, reject invalid `dueAfter`/`dueBefore` values with an
`INVALID_ARGUMENT` `OkhError` rather than comparing malformed strings.

Add private helpers:

```ts
function encodeRef(locator: TodoLocator): string {
  return Buffer.from(JSON.stringify(locator), "utf8").toString("base64url");
}

function fingerprint(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}
```

Do not follow symlinks: `walkFiles` already ignores `Dirent` entries that are not
regular files/directories.

- [ ] **Step 7: Run query/service tests**

```powershell
npx vitest run test/todo-query.test.ts test/todo-service.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 8: Commit querying and scanning**

```powershell
git add src\todos\types.ts src\todos\query.ts src\todos\service.ts test\todo-query.test.ts test\todo-service.test.ts
git commit -m "feat(todos): scan and query memory tasks"
```

---

### Task 4: Add safe create and patch mutations

**Files:**
- Modify: `src/todos/types.ts`
- Modify: `src/todos/service.ts`
- Modify: `src/errors.ts`
- Modify: `test/todo-service.test.ts`

- [ ] **Step 1: Add failing mutation tests**

Add `readFile` to the existing filesystem imports, then extend
`test/todo-service.test.ts` with:

```ts
it("creates a dated memory entry with observation and canonical task metadata", async () => {
  const { root, todos } = await setup();
  const result = await todos.update({
    operation: "create",
    container: "hub",
    module: "mem",
    text: "Buy milk",
    entrySummary: "Grocery reminder",
    observation: "User asked to track groceries.",
    labels: ["shopping"],
    due: "2026-07-11",
    priority: "medium",
  });
  const raw = await readFile(join(root, "mem", "2026-07-10.md"), "utf8");
  expect(raw).toContain("### 2026-07-10T12:00:00.000Z — Grocery reminder");
  expect(raw).toContain("User asked to track groceries.");
  expect(raw).toContain("- [ ] Buy milk #todo #shopping 🔼 📅 2026-07-11 ➕ 2026-07-10");
  expect(result.todo.id).toBeUndefined();
});

it("patches a moved task by fingerprint and rejects stale or duplicate matches", async () => {
  const { root, todos } = await setup();
  const path = join(root, "mem", "tasks.md");
  await writeFile(path, "- [ ] Buy milk #shopping\n", "utf8");
  const listed = await todos.list();
  await writeFile(path, "Heading\n- [ ] Buy milk #shopping\n", "utf8");

  const updated = await todos.update({ operation: "patch", ref: listed.tasks[0]!.ref, completed: true });
  expect(updated.todo.status).toBe("completed");
  expect(await readFile(path, "utf8")).toContain("- [x] Buy milk #shopping ✅ 2026-07-10");

  await expect(todos.update({ operation: "patch", ref: listed.tasks[0]!.ref, completed: false }))
    .rejects.toMatchObject({ code: "CONFLICT" });
});

it("uses a unique existing id before line/fingerprint lookup", async () => {
  const { root, todos } = await setup();
  const path = join(root, "mem", "tasks.md");
  await writeFile(path, "- [ ] First 🆔 stable-1\n", "utf8");
  const listed = await todos.list();
  await writeFile(path, "Intro\n- [ ] Renamed by user 🆔 stable-1\n", "utf8");
  const result = await todos.update({ operation: "patch", ref: listed.tasks[0]!.ref, priority: "high" });
  expect(result.todo.text).toBe("Renamed by user");
  expect(await readFile(path, "utf8")).toContain("⏫");
});

it("preserves CRLF and rejects custom-status mutation", async () => {
  const { root, todos } = await setup();
  const path = join(root, "mem", "tasks.md");
  const original = "- [/] Investigate #work\r\n";
  await writeFile(path, original, "utf8");
  const listed = await todos.list();
  await expect(todos.update({ operation: "patch", ref: listed.tasks[0]!.ref, completed: true }))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(await readFile(path, "utf8")).toBe(original);
});

it("preserves CRLF and final-newline state on a successful patch", async () => {
  const { root, todos } = await setup();
  const path = join(root, "mem", "tasks.md");
  await writeFile(path, "- [ ] First\r\n- [ ] Second", "utf8");
  const listed = await todos.list({ query: "First" });
  await todos.update({ operation: "patch", ref: listed.tasks[0]!.ref, completed: true });
  expect(await readFile(path, "utf8")).toBe("- [x] First ✅ 2026-07-10\r\n- [ ] Second");
});

it("rejects a locator whose path escapes the memory module", async () => {
  const { root, todos } = await setup();
  await writeFile(join(root, "mem", "tasks.md"), "- [ ] Safe task\n", "utf8");
  const listed = await todos.list();
  const locator = JSON.parse(Buffer.from(listed.tasks[0]!.ref, "base64url").toString("utf8"));
  locator.path = "../outside.md";
  const escaped = Buffer.from(JSON.stringify(locator), "utf8").toString("base64url");
  await expect(todos.update({ operation: "patch", ref: escaped, completed: true }))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

it("rejects duplicate existing ids instead of guessing", async () => {
  const { root, todos } = await setup();
  const path = join(root, "mem", "tasks.md");
  await writeFile(path, "- [ ] First 🆔 dup\n- [ ] Second 🆔 dup\n", "utf8");
  const listed = await todos.list();
  await expect(todos.update({ operation: "patch", ref: listed.tasks[0]!.ref, priority: "high" }))
    .rejects.toMatchObject({ code: "CONFLICT" });
});
```

- [ ] **Step 2: Run mutation tests and confirm failure**

```powershell
npx vitest run test/todo-service.test.ts
```

Expected: FAIL because `TodoService.update` does not exist.

- [ ] **Step 3: Add update contracts and conflict error**

Append to `src/todos/types.ts`:

```ts
export type TodoUpdateInput =
  | {
      operation: "create";
      container: string;
      module: string;
      text: string;
      entrySummary?: string;
      observation?: string;
      labels?: string[];
      due?: string;
      priority?: TodoPriority;
    }
  | {
      operation: "patch";
      ref: string;
      completed?: boolean;
      labels?: string[];
      due?: string | null;
      priority?: TodoPriority | null;
    };

export interface TodoUpdateResult {
  todo: TodoRecord;
  dirtyContainer: string;
}
```

Add `"CONFLICT"` to `OkhErrorCode` in `src/errors.ts`.

- [ ] **Step 4: Implement validation, locator decoding, and safe path resolution**

In `src/todos/service.ts`, add:

```ts
function decodeRef(ref: string): TodoLocator {
  try {
    const value = JSON.parse(Buffer.from(ref, "base64url").toString("utf8")) as TodoLocator;
    if (value.v !== 1 || !value.container || !value.module || !value.path || !value.fingerprint) {
      throw new Error("invalid locator");
    }
    return value;
  } catch {
    throw new OkhError("INVALID_ARGUMENT", "Invalid todo ref.");
  }
}

function within(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
```

Validate:

- ISO dates with `YYYY-MM-DD`;
- non-empty task text;
- at least one patch field;
- labels through an exported `normalizeTodoLabel` serializer helper, wrapping
  its validation error in an `INVALID_ARGUMENT` `OkhError`;
- exact target module exists and is `memory`;
- decoded relative path ends in `.md` and remains under `module.absPath`.

- [ ] **Step 5: Implement create and patch under the mutex**

Add:

```ts
async update(input: TodoUpdateInput): Promise<TodoUpdateResult> {
  return this.mutex.run(() => input.operation === "create" ? this.create(input) : this.patch(input));
}
```

Creation:

1. use `now().toISOString()` and its first 10 characters for date;
2. resolve exactly one requested memory module;
3. create `<module>/<YYYY-MM-DD>.md`;
4. build one blank-line-separated entry:

```ts
const sections = [
  `### ${timestamp} — ${input.entrySummary?.trim() || "Todo"}`,
  input.observation?.trim(),
  createTodoLine({
    text: input.text,
    labels: input.labels?.length ? input.labels : ["general"],
    priority: input.priority,
    due: input.due,
    created: today,
  }),
].filter((value): value is string => Boolean(value));
const entry = sections.join(`${newline}${newline}`);
```

5. preserve existing newline style/final newline when appending;
6. write atomically;
7. re-list the target module and return the newly created source line.

Patch lookup:

1. parse all tasks in the target file;
2. if locator has `id`, require exactly one matching ID;
3. otherwise check the original line/fingerprint;
4. otherwise require exactly one matching fingerprint in the file;
5. throw `NOT_FOUND` for no match and `CONFLICT` for changed/duplicate/ambiguous
   matches;
6. reject custom status;
7. call `patchTodoLine`;
8. replace exactly one physical line and preserve CRLF/LF plus final newline;
9. write atomically and return the reparsed task.

Use a sibling temporary file:

```ts
async function atomicWrite(path: string, contents: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, contents, "utf8");
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
```

- [ ] **Step 6: Run all todo unit tests**

```powershell
npx vitest run test/todo-parser.test.ts test/todo-serializer.test.ts test/todo-query.test.ts test/todo-service.test.ts
```

Expected: all todo tests PASS.

- [ ] **Step 7: Commit mutations**

```powershell
git add src\todos src\errors.ts test\todo-service.test.ts
git commit -m "feat(todos): create and safely update memory tasks"
```

---

### Task 5: Expose deterministic todo MCP tools

**Files:**
- Create: `src/server/toolSupport.ts`
- Create: `src/server/todoTools.ts`
- Create: `resources/tool-meta/todos.md`
- Create: `resources/tool-meta/update_todo.md`
- Modify: `src/server/tools.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/toolSchemas.ts`
- Modify: `test/server.test.ts`

- [ ] **Step 1: Add failing MCP surface tests**

Extend `test/server.test.ts`:

```ts
it("exposes todo tools with structured results and mutation annotations", async () => {
  const { client } = await connect();
  const tools = (await client.listTools()).tools;
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "add_container", "add_module", "ask", "config", "context", "inspect",
    "onboard", "run", "sync", "todos", "update_todo",
  ]);
  expect(tools.find((tool) => tool.name === "todos")?.annotations?.readOnlyHint).toBe(true);
  expect(tools.find((tool) => tool.name === "update_todo")?.annotations?.readOnlyHint).toBe(false);
});

it("lists and updates todos through the MCP interface", async () => {
  const { client } = await connect();
  const dir = await makeTempDir();
  cleanups.push(dir);
  await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
  await client.callTool({
    name: "add_module",
    arguments: { container: "hub", path: "mem", type: "memory", name: "Memory", create: true },
  });

  const created = await client.callTool({
    name: "update_todo",
    arguments: {
      operation: "create",
      container: "hub",
      module: "mem",
      text: "Buy milk",
      labels: ["shopping"],
    },
  });
  expect(textOf(created)).toContain("Buy milk");

  const listed = await client.callTool({ name: "todos", arguments: { labels: ["shopping"] } });
  const structured = structuredOf(listed) as { tasks?: Array<{ ref: string; text: string }> };
  expect(structured.tasks?.[0]?.text).toBe("Buy milk");

  const updated = await client.callTool({
    name: "update_todo",
    arguments: { operation: "patch", ref: structured.tasks![0]!.ref, completed: true },
  });
  expect(textOf(updated)).toContain("completed");
});
```

- [ ] **Step 2: Run the server tests and confirm failure**

```powershell
npx vitest run test/server.test.ts
```

Expected: FAIL because todo tools are absent.

- [ ] **Step 3: Extract reusable tool support**

Move `toolReg`, `ok`, `fail`, `handler`, and `isBlank` from
`src/server/tools.ts` into `src/server/toolSupport.ts`. Keep signatures unchanged:

```ts
export async function toolReg<N extends ToolName>(name: N, ctx?: RenderContext);
export function ok(text: string, structured?: Record<string, unknown>): CallToolResult;
export function fail(message: string, hint?: string): CallToolResult;
export function handler<A>(fn: (args: A) => Promise<CallToolResult>);
export function isBlank(value: string): boolean;
```

Update `tools.ts` imports without changing existing behavior.

- [ ] **Step 4: Add tool schemas and metadata**

Add raw shapes to `src/server/toolSchemas.ts`:

```ts
const todoPriority = z.enum(["lowest", "low", "normal", "medium", "high", "highest"]);

todos: {
  container,
  module: moduleArg,
  status: z.enum(["open", "completed", "custom", "all"]).optional(),
  labels: z.array(z.string()).optional(),
  labelMode: z.enum(["any", "all"]).optional(),
  priorities: z.array(todoPriority).optional(),
  dueAfter: z.string().optional(),
  dueBefore: z.string().optional(),
  overdue: z.boolean().optional(),
  query: z.string().optional(),
},
update_todo: {
  operation: z.enum(["create", "patch"]),
  container: z.string().optional(),
  module: z.string().optional(),
  text: z.string().optional(),
  entrySummary: z.string().optional(),
  observation: z.string().optional(),
  ref: z.string().optional(),
  completed: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
  due: z.string().nullable().optional(),
  priority: todoPriority.nullable().optional(),
},
```

Create matching frontmatter argument maps in:

```markdown
<!-- resources/tool-meta/todos.md -->
---
title: Show todo lists
args:
  container: Optional container name.
  module: Optional memory module path.
  status: Filter by open, completed, custom, or all.
  labels: Filter by category labels without requiring a leading hash.
  labelMode: Match any or all selected labels.
  priorities: Filter by normalized priority.
  dueAfter: Include tasks due on or after this YYYY-MM-DD date.
  dueBefore: Include tasks due on or before this YYYY-MM-DD date.
  overdue: Include only incomplete tasks due before today.
  query: Case-insensitive task text or label search.
---
List and filter Markdown todos from memory modules. Use this tool whenever the user asks to show, review, or filter a todo list.
```

```markdown
<!-- resources/tool-meta/update_todo.md -->
---
title: Update one todo
args:
  operation: Create a new todo or patch an existing todo.
  container: Required container for create.
  module: Required memory module for create.
  text: Required task text for create.
  entrySummary: Optional dated memory entry summary for create.
  observation: Optional factual memory text stored with the created todo.
  ref: Required opaque todo reference for patch.
  completed: Complete or reopen the task.
  labels: Replace category labels.
  due: Set a YYYY-MM-DD due date, or null to clear it.
  priority: Set normalized priority, or null to clear it.
---
Create or safely update one todo in a memory module. Never guess a stale or ambiguous task reference.
```

- [ ] **Step 5: Register and format todo tools**

Create `src/server/todoTools.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TodoService } from "../todos/service.js";
import type { TodoListResult, TodoQuery, TodoUpdateInput } from "../todos/types.js";
import { handler, ok, toolReg } from "./toolSupport.js";

function formatTodos(result: TodoListResult): string {
  const head = `Todos: ${result.counts.open} open, ${result.counts.completed} completed, ${result.counts.custom} custom.`;
  if (!result.tasks.length) return `${head}\nNo matching todos.`;
  const bySource = new Map<string, typeof result.tasks>();
  for (const todo of result.tasks) {
    const key = `${todo.source.container}/${todo.source.module}`;
    bySource.set(key, [...(bySource.get(key) ?? []), todo]);
  }
  const sections = [...bySource.entries()].flatMap(([source, tasks]) => [
    `\n${source}`,
    ...tasks.map((todo) => {
      const box = todo.status === "completed" ? "[x]" : todo.status === "open" ? "[ ]" : `[${todo.statusChar}]`;
      const labels = todo.labels.map((label) => `#${label}`).join(" ");
      const due = todo.due ? ` due ${todo.due}` : "";
      return `- ${box} ${todo.text}${labels ? ` ${labels}` : ""}${due} — ${todo.source.path}:${todo.source.line}`;
    }),
  ]);
  return [head, ...sections].join("\n");
}

export async function registerTodoTools(server: McpServer, todos: TodoService): Promise<void> {
  server.registerTool(
    "todos",
    { ...(await toolReg("todos")), annotations: { readOnlyHint: true, openWorldHint: false } },
    handler(async (args: TodoQuery) => {
      const result = await todos.list(args);
      return ok(formatTodos(result), {
        tasks: result.tasks,
        warnings: result.warnings,
        counts: result.counts,
      });
    }),
  );

  server.registerTool(
    "update_todo",
    { ...(await toolReg("update_todo")), annotations: { readOnlyHint: false, openWorldHint: false } },
    handler(async (args: TodoUpdateInput) => {
      const result = await todos.update(args);
      return ok(
        `${result.todo.status === "completed" ? "Completed" : "Updated"} "${result.todo.text}" in ${result.dirtyContainer}.`,
        { todo: result.todo, dirtyContainer: result.dirtyContainer },
      );
    }),
  );
}
```

Let `TodoService` own conditional argument validation so the tool remains a thin
adapter.

- [ ] **Step 6: Inject and register `TodoService`**

Modify `src/server/index.ts`:

```ts
import { TodoService } from "../todos/service.js";

export interface BuildServerOptions {
  paths?: OkhPaths;
  service?: ContainerService;
  todoService?: TodoService;
}

const todoService = options.todoService ?? new TodoService(service);
await registerTools(server, service, paths, todoService);
```

Modify `registerTools` to accept `TodoService` and call
`await registerTodoTools(server, todoService)` after existing registration.

- [ ] **Step 7: Run targeted server tests**

```powershell
npx vitest run test/server.test.ts test/prompts.test.ts
```

Expected: all targeted tests PASS.

- [ ] **Step 8: Commit MCP tools**

```powershell
git add src\server src\errors.ts resources\tool-meta test\server.test.ts
git commit -m "feat(todos): expose deterministic MCP tools"
```

---

### Task 6: Update memory skills and routing discipline

**Files:**
- Modify: `resources/module-types/memory/skills/remember/SKILL.md`
- Create: `resources/module-types/memory/skills/todo/SKILL.md`
- Modify: `resources/prompts/instructions.md`
- Modify: `test/skills.test.ts`
- Modify: `test/run.test.ts`
- Modify: `test/prompts.test.ts`

- [ ] **Step 1: Write failing resource/skill assertions**

Update existing expectations:

```ts
// test/skills.test.ts
expect((await vendoredSkills("memory")).map((s) => s.name).sort())
  .toEqual(["reflect", "remember", "todo"]);
```

```ts
// test/run.test.ts
const todo = await service.resolveSkill("h", "mem", "todo");
expect(todo.body).toContain("update_todo");
expect(todo.body).toContain("complete");
expect(todo.body).toContain("due");
expect(todo.body).toContain("priority");
```

```ts
// test/prompts.test.ts
const instructions = await buildInstructions({ wakePhrase: "hub" });
expect(instructions).toContain("todo");
expect(instructions).toContain("`todos`");
```

- [ ] **Step 2: Run skill/prompt tests and confirm failure**

```powershell
npx vitest run test/skills.test.ts test/run.test.ts test/prompts.test.ts
```

Expected: FAIL because the todo skill and routing text are absent.

- [ ] **Step 3: Rewrite the remember skill**

Keep the existing factual-memory rules, then add a todo branch with explicit
tool calls. The body must state:

```markdown
If the input contains an explicit action, commitment, reminder, or task the user wants tracked:

1. Choose exactly one target memory module.
2. Use `todos { container, module }` to inspect existing labels.
3. Extract concise task text. Keep factual observation text separate.
4. Normalize explicit relative dates to `YYYY-MM-DD`.
5. Map urgency only when the user implies it: lowest, low, normal, medium, high, highest.
6. Use explicit labels; otherwise reuse matching existing labels; otherwise create short lowercase kebab-case labels; fall back to `general`.
7. Propose the exact checkbox fields and get confirmation.
8. Call `update_todo` with `operation: "create"`, including `entrySummary` and `observation` when the same memory contains a factual observation.
9. Call `sync` for the affected container after confirmation.

Do not add task IDs. Do not infer recurrence or dependencies.
```

Retain append-only/no-conclusions requirements for ordinary observations.

- [ ] **Step 4: Add the todo skill**

Create `resources/module-types/memory/skills/todo/SKILL.md`:

```markdown
---
name: todo
description: Add, complete, reopen, relabel, reprioritize, or reschedule todos in this memory module.
---

Manage todos through the deterministic todo tools.

1. Call `todos` scoped to this container/module.
2. Resolve the user's task reference. If zero or multiple tasks match, ask the user to choose; never guess.
3. Support only:
   - add;
   - complete or reopen;
   - replace labels;
   - set or clear due date;
   - set or clear priority.
4. For add, normalize labels, due date, and priority exactly as the `remember` skill does.
5. Show the exact proposed change and get confirmation.
6. Call `update_todo` once with `operation: "create"` or `operation: "patch"`.
7. Report the local change, then call `sync` for the affected container.

Do not delete tasks, rename task text, add IDs, manage recurrence/dependencies, or mutate custom checkbox statuses.
```

- [ ] **Step 5: Add global routing**

Extend `resources/prompts/instructions.md` with one concise sentence:

```markdown
When the user asks to show, review, filter, or check todo lists, call `todos`; use a memory module's `todo` skill for natural-language todo changes.
```

- [ ] **Step 6: Run skill/prompt tests**

```powershell
npx vitest run test/skills.test.ts test/run.test.ts test/prompts.test.ts
```

Expected: all targeted tests PASS.

- [ ] **Step 7: Commit skills and routing**

```powershell
git add resources\module-types\memory\skills resources\prompts\instructions.md test\skills.test.ts test\run.test.ts test\prompts.test.ts
git commit -m "feat(todos): add memory todo skills and routing"
```

---

### Task 7: Build and register the MCP App

**Files:**
- Create: `app/todos/index.html`
- Create: `app/todos/model.ts`
- Create: `app/todos/main.ts`
- Create: `scripts/build-todo-app.mjs`
- Create: `tsconfig.app.json`
- Create: `test/todo-app.test.ts`
- Modify: `src/server/todoTools.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `test/server.test.ts`

- [ ] **Step 1: Install Node 18-compatible dependencies**

Run:

```powershell
npm install @modelcontextprotocol/ext-apps@1.1.2
npm install --save-dev esbuild@0.28.1
```

Expected: `package.json` and `package-lock.json` update without changing the
project's `node >=18` engine.

- [ ] **Step 2: Write failing app model/resource tests**

Create `test/todo-app.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyAppFilters } from "../app/todos/model.js";
import type { TodoRecord } from "../src/todos/types.js";

const base: TodoRecord = {
  ref: "1",
  status: "open",
  statusChar: " ",
  readOnly: false,
  text: "Buy milk",
  labels: ["shopping"],
  priority: "medium",
  due: "2026-07-11",
  warnings: [],
  source: { container: "hub", module: "mem", path: "tasks.md", line: 1 },
};

describe("todo app model", () => {
  it("applies UI status, label, source, priority, due, and text filters", () => {
    expect(applyAppFilters([base], {
      status: "open",
      labels: ["shopping"],
      source: "hub/mem",
      priorities: ["medium"],
      due: "upcoming",
      dueFrom: "2026-07-10",
      dueTo: "2026-07-12",
      query: "milk",
    }, "2026-07-10")).toEqual([base]);
  });
});
```

Extend `test/server.test.ts`:

```ts
it("links todos to an MCP App resource", async () => {
  const { client } = await connect();
  const tool = (await client.listTools()).tools.find((item) => item.name === "todos");
  expect(tool?._meta).toMatchObject({
    ui: { resourceUri: "ui://open-knowledge-hub/todos" },
  });

  const resource = await client.readResource({ uri: "ui://open-knowledge-hub/todos" });
  expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
  expect("text" in resource.contents[0]!).toBe(true);
  expect(resource.contents[0] && "text" in resource.contents[0] ? resource.contents[0].text : "")
    .toContain("Open Knowledge Hub Todos");
});
```

- [ ] **Step 3: Run tests and confirm failure**

```powershell
npx vitest run test/todo-app.test.ts test/server.test.ts
```

Expected: FAIL because app files/resource metadata do not exist.

- [ ] **Step 4: Add app typecheck and build scripts**

Create `tsconfig.app.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["app/**/*.ts", "src/todos/types.ts", "src/todos/query.ts"]
}
```

Create `scripts/build-todo-app.mjs` that:

1. bundles `app/todos/main.ts` with esbuild using `platform: "browser"`,
   `format: "esm"`, `target: "es2022"`, `bundle: true`, `write: false`;
2. reads `app/todos/index.html`;
3. replaces `<!-- APP_SCRIPT -->` with one inline module script;
4. escapes literal `</script` inside the bundle;
5. writes `dist/apps/todos.html`, creating the directory.

Use:

```js
const result = await build({
  entryPoints: ["app/todos/main.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  minify: true,
});
```

Update package scripts:

```json
{
  "build:server": "tsc -p tsconfig.json",
  "build:app": "node scripts/build-todo-app.mjs",
  "build": "npm run build:server && npm run build:app",
  "dev": "npm run build:app && tsx src/index.ts",
  "typecheck:server": "tsc -p tsconfig.json --noEmit",
  "typecheck:app": "tsc -p tsconfig.app.json --noEmit",
  "typecheck": "npm run typecheck:server && npm run typecheck:app",
  "test": "npm run build:app && vitest run",
  "test:watch": "npm run build:app && vitest",
  "inspect:dev": "npm run build:app && npx @modelcontextprotocol/inspector npx tsx src/index.ts"
}
```

Keep all existing eval scripts and `prepare: npm run build`.

- [ ] **Step 5: Implement the pure app model**

Create `app/todos/model.ts`:

```ts
import { filterTodos, sortTodos } from "../../src/todos/query.js";
import type { TodoPriority, TodoRecord, TodoStatus } from "../../src/todos/types.js";

export interface AppFilters {
  status: TodoStatus | "all";
  labels: string[];
  source: string;
  priorities: TodoPriority[];
  due: "all" | "overdue" | "today" | "upcoming" | "none";
  dueFrom: string;
  dueTo: string;
  query: string;
}

export function applyAppFilters(tasks: TodoRecord[], filters: AppFilters, today: string): TodoRecord[] {
  const sourceFiltered = tasks.filter((todo) =>
    !filters.source || `${todo.source.container}/${todo.source.module}` === filters.source);
  const dueFiltered = sourceFiltered.filter((todo) => {
    const stateMatches =
      filters.due === "all" ||
      (filters.due === "none" && !todo.due) ||
      (filters.due === "overdue" && todo.status === "open" && Boolean(todo.due && todo.due < today)) ||
      (filters.due === "today" && todo.due === today) ||
      (filters.due === "upcoming" && Boolean(todo.due && todo.due > today));
    if (!stateMatches) return false;
    if (filters.dueFrom && (!todo.due || todo.due < filters.dueFrom)) return false;
    if (filters.dueTo && (!todo.due || todo.due > filters.dueTo)) return false;
    return true;
  });
  return sortTodos(filterTodos(dueFiltered, {
    status: filters.status,
    labels: filters.labels,
    labelMode: "any",
    priorities: filters.priorities,
    query: filters.query,
  }, today), today);
}
```

- [ ] **Step 6: Build the app shell**

Create `app/todos/index.html` as a complete HTML5 document with:

- title `Open Knowledge Hub Todos`;
- CSS variables with light/dark color-scheme support;
- responsive filter bar;
- count/status buttons;
- multi-select label chips;
- source/priority/due selects;
- optional due-from and due-to date inputs;
- text search;
- unified task list;
- error banner;
- local-unsynced banner;
- `<!-- APP_SCRIPT -->` before `</body>`.

Use no network URLs, external scripts, fonts, images, or styles.

- [ ] **Step 7: Implement MCP Apps behavior**

Create `app/todos/main.ts` using:

```ts
import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TodoListResult, TodoRecord, TodoUpdateResult } from "../../src/todos/types.js";
import { applyAppFilters, type AppFilters } from "./model.js";

const app = new App({ name: "Open Knowledge Hub Todos", version: "1.0.0" });
```

Implement:

- a type guard that reads `result.structuredContent` as `TodoListResult`;
- `app.ontoolresult` before `app.connect()` to receive the initial `todos` result;
- DOM event delegation for filters and checkboxes;
- disabled/read-only checkboxes for custom statuses;
- `app.callServerTool({ name: "update_todo", arguments: { operation: "patch", ref, completed } })`;
- in-place replacement from `TodoUpdateResult.todo`;
- a `Set<string>` of dirty containers displayed in the unsynced banner;
- on tool-level or transport error, render the message and call
  `app.callServerTool({ name: "todos", arguments: {} })` to refresh;
- HTML escaping for every task-controlled string before assigning markup;
- no create/edit/delete controls.

Call `await app.connect()` after handlers are installed.

- [ ] **Step 8: Register the app tool and resource**

Change `src/server/todoTools.ts` to use:

```ts
import { readFile } from "node:fs/promises";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

export const TODO_APP_URI = "ui://open-knowledge-hub/todos";
const TODO_APP_HTML = new URL("../../dist/apps/todos.html", import.meta.url);
```

Register `todos` with:

```ts
registerAppTool(server, "todos", {
  ...(await toolReg("todos")),
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: TODO_APP_URI, visibility: ["model", "app"] } },
}, handler(async (args: TodoQuery) => {
  const result = await todos.list(args);
  return ok(formatTodos(result), {
    tasks: result.tasks,
    warnings: result.warnings,
    counts: result.counts,
  });
}));
```

Replace the base `update_todo` registration with:

```ts
registerAppTool(server, "update_todo", {
  ...(await toolReg("update_todo")),
  annotations: { readOnlyHint: false, openWorldHint: false },
  _meta: { ui: { visibility: ["model", "app"] } },
}, handler(async (args: TodoUpdateInput) => {
  const result = await todos.update(args);
  return ok(
    `${result.todo.status === "completed" ? "Completed" : "Updated"} "${result.todo.text}" in ${result.dirtyContainer}.`,
    { todo: result.todo, dirtyContainer: result.dirtyContainer },
  );
}));
```

Register:

```ts
registerAppResource(
  server,
  "Open Knowledge Hub Todos",
  TODO_APP_URI,
  {
    description: "Interactive filtering and completion for memory-module todos.",
    _meta: { ui: { prefersBorder: true } },
  },
  async () => ({
    contents: [{
      uri: TODO_APP_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(TODO_APP_HTML, "utf8"),
      _meta: { ui: { prefersBorder: true } },
    }],
  }),
);
```

- [ ] **Step 9: Build, typecheck, and run app/server tests**

```powershell
npm run build:app
npm run typecheck:app
npx vitest run test/todo-app.test.ts test/server.test.ts
```

Expected: app build succeeds and all targeted tests PASS.

- [ ] **Step 10: Commit the MCP App**

```powershell
git add app scripts tsconfig.app.json package.json package-lock.json src\server\todoTools.ts test\todo-app.test.ts test\server.test.ts
git commit -m "feat(todos): render todo lists as an MCP app"
```

---

### Task 8: Add deterministic and end-to-end eval coverage

**Files:**
- Modify: `eval/fixtures/kb-hub/mem/2026-02-15.md`
- Create: `eval/assertions/todo-markdown.ts`
- Create: `eval-test/assertions/todo-markdown.test.ts`
- Create: `eval/scenarios/todos/show.yaml`
- Create: `eval/scenarios/remember/todo.yaml`
- Create: `eval/scenarios/todo/complete.yaml`
- Modify: `eval/README.md`

- [ ] **Step 1: Seed fixture todos without changing memory file count**

Append to `eval/fixtures/kb-hub/mem/2026-02-15.md`:

```markdown

## Todos

- [ ] Buy milk #todo #shopping ➕ 2026-07-10
- [ ] Review launch notes #todo #work #private ⏫ 📅 2026-07-20 ➕ 2026-07-10
```

The module still has two Markdown files, so existing `baselineFileCount: 2`
remember scenarios remain valid.

- [ ] **Step 2: Write failing assertion tests**

Create `eval-test/assertions/todo-markdown.test.ts` using a temporary provisioned
context. Cover:

1. matching task text, status, labels, due, and priority passes;
2. missing label fails with a reason naming the label;
3. completed/open mismatch fails;
4. malformed task Markdown does not crash the assertion.

Call the assertion function directly with `providerResponse.metadata.containerPath`
pointing at the temporary fixture root.

- [ ] **Step 3: Run the assertion test and confirm failure**

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/assertions/todo-markdown.test.ts
```

Expected: FAIL because the assertion does not exist.

- [ ] **Step 4: Implement `todo-markdown` assertion**

Create `eval/assertions/todo-markdown.ts`. Reuse production parsing:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { walkFiles } from "../../src/modules/fs.js";
import { parseTodoLine } from "../../src/todos/parser.js";
```

Configuration:

```ts
interface TodoAssertionConfig {
  module?: string;
  text: string;
  status?: "open" | "completed";
  labels?: string[];
  due?: string;
  priority?: string;
}
```

Scan module Markdown, find tasks whose normalized text includes configured text
case-insensitively, and pass only when one match satisfies every configured field.
Return deterministic `pass`, `score`, and a reason containing mismatches.

- [ ] **Step 5: Add show/list eval**

Create `eval/scenarios/todos/show.yaml`:

```yaml
- config:
    - vars:
        env: local-and-git
        prompt: |
          Use the open-knowledge-hub MCP tools. Show my open shopping todos across
          all registered memory modules.
  tests:
    - description: Todos - show shopping list - uses app-backed tool
      assert:
        - { type: javascript, value: file://assertions/tools-called.ts, config: { expect: [todos] } }
        - { type: javascript, value: file://assertions/transcript.ts, config: { mustContain: ["Buy milk", "shopping"] } }
        - type: javascript
          value: file://assertions/judge.ts
          config:
            criteria:
              - id: shopping-filter
                text: The response shows the open shopping todo and does not invent unrelated tasks.
```

- [ ] **Step 6: Add remember-todo eval**

Create `eval/scenarios/remember/todo.yaml`:

```yaml
- config:
    - vars:
        env: local-and-git
        prompt: |
          Use the open-knowledge-hub MCP tools. In container "kb-hub" memory module
          "mem", remember this todo: buy printer ink by 2026-07-15. It is high
          priority and belongs on the shopping list.
  tests:
    - description: Remember - todo - writes Obsidian metadata
      assert:
        - { type: javascript, value: file://assertions/tools-called.ts, config: { expect: [run, update_todo, sync] } }
        - type: javascript
          value: file://assertions/todo-markdown.ts
          config:
            module: mem
            text: buy printer ink
            status: open
            labels: [shopping]
            due: 2026-07-15
            priority: high
        - type: javascript
          value: file://assertions/judge.ts
          config:
            artifacts: { module: mem }
            criteria:
              - id: obsidian-todo
                text: The on-disk memory contains one open Obsidian-compatible printer-ink todo with shopping label, high priority, and the requested due date.
```

- [ ] **Step 7: Add complete-via-skill eval**

Create `eval/scenarios/todo/complete.yaml`:

```yaml
- config:
    - vars:
        env: local-and-git
        prompt: |
          Use the open-knowledge-hub MCP tools. In container "kb-hub" memory module
          "mem", use the todo skill to mark "Buy milk" complete.
  tests:
    - description: Todo - complete item - skill updates status
      assert:
        - { type: javascript, value: file://assertions/tools-called.ts, config: { expect: [run, todos, update_todo, sync] } }
        - type: javascript
          value: file://assertions/todo-markdown.ts
          config: { module: mem, text: Buy milk, status: completed, labels: [shopping] }
        - type: javascript
          value: file://assertions/judge.ts
          config:
            artifacts: { module: mem }
            criteria:
              - id: completed-only-target
                text: The Buy milk task is completed and unrelated memory/todos remain intact.
```

- [ ] **Step 8: Run eval typecheck/unit/config validation**

Before validation, change the opening sentence in `eval/README.md` from a fixed
scenario count to:

```markdown
End-to-end scenarios run two ways:
```

```powershell
npm run typecheck:eval
npm run test:eval
npm run eval:validate
```

Expected: all commands PASS and promptfoo reports `Configuration is valid.`

- [ ] **Step 9: Commit eval coverage**

```powershell
git add eval eval-test
git commit -m "test(todos): cover todo tools skills and markdown"
```

---

### Task 9: Update user-facing docs and run complete validation

**Files:**
- Modify: `README.md`
- Modify: `CONTEXT.md`

- [ ] **Step 1: Document the new deterministic surface**

Update `README.md`:

- add `todos` and `update_todo` to operational tools in the introduction and table;
- update memory vendored skills to `remember`, `reflect`, `todo`;
- describe todos as Markdown checkboxes with optional Obsidian tags, priority,
  due/created/completion dates;
- state that todo requests render an MCP App on supporting hosts and return text
  elsewhere;
- change `**Resources:** none.` to name `ui://open-knowledge-hub/todos`;
- add one example:

```markdown
- `todos { labels: ["shopping"], status: "open" }` → interactive filtered list
  (or text fallback); app checkbox changes remain local until `sync`.
```

Update `CONTEXT.md` operational tools and runtime dependencies to include the two
todo tools and MCP Apps.

- [ ] **Step 2: Run formatting/diff checks for docs**

```powershell
git --no-pager diff --check
```

Expected: no output.

- [ ] **Step 3: Commit documentation**

```powershell
git add README.md CONTEXT.md
git commit -m "docs: document memory todo lists and app"
```

- [ ] **Step 4: Run targeted todo verification**

```powershell
npm run build
npm run typecheck
npx vitest run test/todo-parser.test.ts test/todo-serializer.test.ts test/todo-query.test.ts test/todo-service.test.ts test/todo-app.test.ts test/server.test.ts test/skills.test.ts test/run.test.ts test/prompts.test.ts
```

Expected: build/typecheck succeed and all targeted tests PASS.

- [ ] **Step 5: Run full repository and eval verification**

```powershell
npm test
npm run typecheck:eval
npm run test:eval
npm run eval:validate
npm run eval
```

Expected:

- all core Vitest tests pass;
- all eval Vitest tests pass;
- promptfoo configuration is valid;
- full Copilot CLI end-to-end eval passes, including the three new todo scenarios.

- [ ] **Step 6: Verify the package contains the app**

```powershell
npm pack --dry-run
```

Expected: output includes `dist/apps/todos.html`, server JavaScript, declarations,
`resources/tool-meta/todos.md`, and `resources/tool-meta/update_todo.md`.

- [ ] **Step 7: Inspect final history and worktree**

```powershell
git --no-pager log --oneline -12
git --no-pager status --short
```

Expected: task commits are present and the worktree is clean.
