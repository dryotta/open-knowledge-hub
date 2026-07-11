import { describe, expect, it } from "vitest";
import { filterTodos, sortTodos } from "../src/todos/query.js";
import type { TodoRecord } from "../src/todos/types.js";

function makeTodo(overrides: Partial<TodoRecord> = {}): TodoRecord {
  return {
    ref: overrides.ref ?? `ref:${overrides.source?.path ?? "tasks.md"}:${overrides.source?.line ?? 1}`,
    status: "open",
    statusChar: " ",
    readOnly: false,
    text: "Task",
    labels: [],
    priority: "normal",
    warnings: [],
    source: {
      container: "alpha",
      module: "memory",
      path: "tasks.md",
      line: 1,
      ...overrides.source,
    },
    ...overrides,
  };
}

describe("filterTodos", () => {
  it("selects only Buy milk when all labels, status, priority, due-before, and text filters match", () => {
    const tasks = [
      makeTodo({
        text: "Buy milk",
        labels: ["shopping", "errand"],
        priority: "high",
        due: "2026-07-10",
      }),
      makeTodo({
        text: "Buy bread",
        labels: ["shopping", "errand"],
        priority: "high",
        due: "2026-07-10",
        source: { path: "bread.md", line: 1 },
      }),
      makeTodo({
        text: "Buy milk",
        labels: ["shopping"],
        priority: "high",
        due: "2026-07-10",
        source: { path: "one-label.md", line: 1 },
      }),
      makeTodo({
        text: "Buy milk",
        labels: ["shopping", "errand"],
        priority: "medium",
        due: "2026-07-10",
        source: { path: "priority.md", line: 1 },
      }),
      makeTodo({
        text: "Buy milk",
        labels: ["shopping", "errand"],
        priority: "high",
        due: "2026-07-11",
        source: { path: "late.md", line: 1 },
      }),
      makeTodo({
        text: "Buy milk",
        labels: ["shopping", "errand"],
        priority: "high",
        due: "2026-07-10",
        status: "completed",
        statusChar: "x",
        completed: "2026-07-10",
        source: { path: "done.md", line: 1 },
      }),
    ];

    const result = filterTodos(tasks, {
      status: "open",
      labels: ["#shopping", "ERRAND"],
      labelMode: "all",
      priorities: ["high"],
      dueBefore: "2026-07-10",
      query: "milk",
    }, "2026-07-10");

    expect(result.map((task) => task.text)).toEqual(["Buy milk"]);
    expect(tasks[0]?.text).toBe("Buy milk");
  });

  it("supports container and module filters with default any-label matching", () => {
    const tasks = [
      makeTodo({
        source: { container: "alpha", module: "memory" },
        labels: ["home"],
        text: "Alpha home",
      }),
      makeTodo({
        source: { container: "alpha", module: "journal", path: "journal.md", line: 1 },
        labels: ["home"],
        text: "Wrong module",
      }),
      makeTodo({
        source: { container: "beta", module: "memory", path: "beta.md", line: 1 },
        labels: ["urgent"],
        text: "Wrong container",
      }),
    ];

    const result = filterTodos(tasks, {
      container: "alpha",
      module: "memory",
      labels: ["#urgent", "HOME"],
    }, "2026-07-10");

    expect(result.map((task) => task.text)).toEqual(["Alpha home"]);
  });

  it("treats dueAfter and dueBefore as inclusive", () => {
    const tasks = [
      makeTodo({ text: "Start", due: "2026-07-10" }),
      makeTodo({ text: "Middle", due: "2026-07-11", source: { path: "middle.md", line: 1 } }),
      makeTodo({ text: "End", due: "2026-07-12", source: { path: "end.md", line: 1 } }),
      makeTodo({ text: "No due", source: { path: "none.md", line: 1 } }),
    ];

    const result = filterTodos(tasks, {
      dueAfter: "2026-07-10",
      dueBefore: "2026-07-11",
    }, "2026-07-10");

    expect(result.map((task) => task.text)).toEqual(["Start", "Middle"]);
  });

  it("matches overdue tasks without including completed ones", () => {
    const tasks = [
      makeTodo({ text: "Past due", due: "2026-07-09" }),
      makeTodo({
        text: "Completed past due",
        status: "completed",
        statusChar: "x",
        due: "2026-07-09",
        completed: "2026-07-10",
        source: { path: "done.md", line: 1 },
      }),
      makeTodo({ text: "Due today", due: "2026-07-10", source: { path: "today.md", line: 1 } }),
    ];

    const result = filterTodos(tasks, { overdue: true }, "2026-07-10");

    expect(result.map((task) => task.text)).toEqual(["Past due"]);
  });

  it("matches free-text queries against labels case-insensitively", () => {
    const tasks = [
      makeTodo({ text: "Read book", labels: ["Home/Office"] }),
      makeTodo({ text: "Call mom", labels: ["family"], source: { path: "call.md", line: 1 } }),
    ];

    const result = filterTodos(tasks, { query: "office" }, "2026-07-10");

    expect(result.map((task) => task.text)).toEqual(["Read book"]);
  });
});

describe("sortTodos", () => {
  it("orders overdue tasks before the nearest due date and later due dates", () => {
    const tasks = [
      makeTodo({ text: "Later", due: "2026-07-12", source: { path: "later.md", line: 1 } }),
      makeTodo({ text: "Nearest", due: "2026-07-10", source: { path: "near.md", line: 1 } }),
      makeTodo({ text: "Overdue", due: "2026-07-09", source: { path: "overdue.md", line: 1 } }),
    ];

    const result = sortTodos(tasks, "2026-07-10");

    expect(result.map((task) => task.text)).toEqual(["Overdue", "Nearest", "Later"]);
    expect(tasks.map((task) => task.text)).toEqual(["Later", "Nearest", "Overdue"]);
  });

  it("breaks ties by priority, created date, then deterministic source order", () => {
    const tasks = [
      makeTodo({
        text: "Low priority",
        due: "2026-07-20",
        priority: "low",
        created: "2026-07-12",
        source: { path: "z.md", line: 1 },
      }),
      makeTodo({
        text: "Older high priority",
        due: "2026-07-20",
        priority: "high",
        created: "2026-07-11",
        source: { path: "older.md", line: 1 },
      }),
      makeTodo({
        text: "Same day later line",
        due: "2026-07-20",
        priority: "high",
        created: "2026-07-12",
        source: { path: "same.md", line: 10 },
      }),
      makeTodo({
        text: "Same day earlier line",
        due: "2026-07-20",
        priority: "high",
        created: "2026-07-12",
        source: { path: "same.md", line: 2 },
      }),
    ];

    const result = sortTodos(tasks, "2026-07-10");

    expect(result.map((task) => task.text)).toEqual([
      "Same day earlier line",
      "Same day later line",
      "Older high priority",
      "Low priority",
    ]);
  });
});
