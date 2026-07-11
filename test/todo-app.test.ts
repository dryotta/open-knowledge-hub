import { describe, expect, it } from "vitest";
import { applyAppFilters, type AppFilters } from "../app/todos/model.js";
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

describe("applyAppFilters", () => {
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
