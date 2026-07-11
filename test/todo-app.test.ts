import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyAppFilters, canApplyUpdates, mergeRefreshedTasks, type AppFilters } from "../app/todos/model.js";
import type { TodoRecord } from "../src/todos/types.js";

const TODAY = "2026-07-10";

function todo(ref: string, overrides: Partial<TodoRecord> = {}): TodoRecord {
  return {
    ref,
    status: "open",
    statusChar: " ",
    readOnly: false,
    text: ref,
    labels: [],
    priority: "normal",
    warnings: [],
    source: {
      container: "alpha",
      module: "memory",
      path: `${ref}.md`,
      line: 1,
    },
    ...overrides,
  };
}

const tasks = [
  todo("overdue", { text: "Fix release blocker", labels: ["work", "urgent"], priority: "highest", due: "2026-07-09" }),
  todo("today", { text: "Buy milk", labels: ["home"], priority: "high", due: TODAY }),
  todo("upcoming", {
    text: "Write roadmap",
    labels: ["work", "planning"],
    priority: "medium",
    due: "2026-07-11",
    source: { container: "beta", module: "journal", path: "roadmap.md", line: 2 },
  }),
  todo("none", { text: "Someday task", priority: "low" }),
  todo("completed", {
    status: "completed",
    statusChar: "x",
    text: "Archive notes",
    labels: ["work"],
    due: "2026-07-08",
    completed: TODAY,
  }),
  todo("custom", { status: "custom", statusChar: "-", readOnly: true, text: "Waiting on review", due: "2026-07-12" }),
];

function filters(overrides: Partial<AppFilters> = {}): AppFilters {
  return {
    status: "all",
    labels: [],
    source: "",
    priorities: [],
    due: "all",
    dueFrom: "",
    dueTo: "",
    query: "",
    ...overrides,
  };
}

function refs(result: TodoRecord[]): string[] {
  return result.map((task) => task.ref);
}

function normalizedWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("applyAppFilters", () => {
  it("uses the unified todos update flow in source and bundled app code", async () => {
    const root = process.cwd();
    const sourcePath = join(root, "app", "todos", "main.ts");
    const bundlePath = join(root, "dist", "apps", "todos.html");
    const buildScriptPath = join(root, "scripts", "build-todo-app.mjs");
    const source = normalizedWhitespace(await readFile(sourcePath, "utf8"));

    expect(source).toContain('name: "todos"');
    expect(source).toContain('operation: "update"');
    expect(source).toContain("apply: true");
    expect(source).toContain('operation: "list"');
    expect(source).not.toContain("update_todo");
    expect(source).not.toContain('operation: "patch"');

    const build = spawnSync(process.execPath, [buildScriptPath], {
      cwd: root,
      encoding: "utf8",
    });
    expect(build.status, build.stderr || build.stdout).toBe(0);

    const bundle = await readFile(bundlePath, "utf8");
    expect(bundle).toMatch(/name:\s*"todos"/);
    expect(bundle).toMatch(/operation:\s*"update"/);
    expect(bundle).toMatch(/apply:\s*!0|apply:\s*true/);
    expect(bundle).toMatch(/operation:\s*"list"/);
    expect(bundle).not.toMatch(/update_todo/);
    expect(bundle).not.toMatch(/operation:\s*"patch"/);
  });

  it("merges a filtered refresh back into the full task list during rollback", () => {
    const visible = applyAppFilters(tasks, filters({ labels: ["home"] }), TODAY);
    const refreshed = visible.map((task) => task.ref === "today" ? { ...task, warnings: ["server copy"] } : task);

    const merged = mergeRefreshedTasks(tasks, refreshed, "today");

    expect(merged).not.toBeNull();
    expect(refs(merged ?? [])).toEqual(refs(tasks));
    expect(merged?.find((task) => task.ref === "today")?.warnings).toEqual(["server copy"]);
    expect(merged?.find((task) => task.ref === "overdue")?.text).toBe("Fix release blocker");
  });

  it("signals when a filtered refresh cannot reconcile the toggled todo", () => {
    expect(mergeRefreshedTasks(tasks, [], "today")).toBeNull();
  });

  it("supports every status including all", () => {
    expect(refs(applyAppFilters(tasks, filters({ status: "open" }), TODAY))).toEqual(["overdue", "today", "upcoming", "none"]);
    expect(refs(applyAppFilters(tasks, filters({ status: "completed" }), TODAY))).toEqual(["completed"]);
    expect(refs(applyAppFilters(tasks, filters({ status: "custom" }), TODAY))).toEqual(["custom"]);
    expect(applyAppFilters(tasks, filters({ status: "all" }), TODAY)).toHaveLength(tasks.length);
  });

  it("matches any selected label, exact source, selected priorities, and text", () => {
    expect(refs(applyAppFilters(tasks, filters({ labels: ["home", "planning"] }), TODAY))).toEqual(["today", "upcoming"]);
    expect(refs(applyAppFilters(tasks, filters({ source: "beta/journal" }), TODAY))).toEqual(["upcoming"]);
    expect(refs(applyAppFilters(tasks, filters({ priorities: ["highest", "low"] }), TODAY))).toEqual(["overdue", "none"]);
    expect(refs(applyAppFilters(tasks, filters({ query: "release BLOCKER" }), TODAY))).toEqual(["overdue"]);
  });

  it.each([
    ["all", ["overdue", "completed", "today", "upcoming", "custom", "none"]],
    ["overdue", ["overdue"]],
    ["today", ["today"]],
    ["upcoming", ["upcoming", "custom"]],
    ["none", ["none"]],
  ] as const)("applies the %s due-state filter", (due, expected) => {
    expect(refs(applyAppFilters(tasks, filters({ due }), TODAY))).toEqual(expected);
  });

  it("applies inclusive due-from and due-to bounds and excludes tasks without due dates", () => {
    expect(refs(applyAppFilters(tasks, filters({ dueFrom: TODAY, dueTo: "2026-07-11" }), TODAY))).toEqual(["today", "upcoming"]);
  });

  it("uses canonical todo sorting", () => {
    expect(refs(applyAppFilters([tasks[3]!, tasks[2]!, tasks[1]!, tasks[0]!], filters(), TODAY))).toEqual([
      "overdue",
      "today",
      "upcoming",
      "none",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [tasks[3]!, tasks[0]!, tasks[1]!];
    const before = [...input];

    applyAppFilters(input, filters(), TODAY);

    expect(input).toEqual(before);
  });
});

describe("canApplyUpdates", () => {
  it("allows updates when the host advertises serverTools", () => {
    expect(canApplyUpdates({ serverTools: {} })).toBe(true);
    expect(canApplyUpdates({ serverTools: { listChanged: true } })).toBe(true);
  });

  it("blocks updates when the host advertises capabilities but omits serverTools", () => {
    expect(canApplyUpdates({})).toBe(false);
    expect(canApplyUpdates({ openLinks: {} })).toBe(false);
    expect(canApplyUpdates({ serverTools: false })).toBe(false);
    expect(canApplyUpdates({ serverTools: null })).toBe(false);
  });

  it("stays optimistic when capabilities are unknown so the timeout can surface hangs", () => {
    expect(canApplyUpdates(undefined)).toBe(true);
    expect(canApplyUpdates(null)).toBe(true);
  });
});
