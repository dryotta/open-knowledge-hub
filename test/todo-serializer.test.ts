import { describe, expect, it } from "vitest";
import { parseTodoLine } from "../src/todos/parser.js";
import { createTodoLine, normalizeTodoLabel, patchTodoLine } from "../src/todos/serializer.js";

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

  it("normalizes labels by accepting # prefixes, lowercasing, deduplicating, and allowing nesting", () => {
    expect(normalizeTodoLabel("#Work/Private")).toBe("work/private");
    expect(createTodoLine({
      text: "Plan trip",
      labels: ["#Work", "work", "Work/Private"],
      created: "2026-07-10",
    })).toBe("- [ ] Plan trip #todo #work #work/private ➕ 2026-07-10");
  });

  it("rejects invalid or empty labels", () => {
    expect(() => normalizeTodoLabel("")).toThrow();
    expect(() => normalizeTodoLabel("   ")).toThrow();
    expect(() => normalizeTodoLabel("bad label")).toThrow();
    expect(() => normalizeTodoLabel("bad!")).toThrow();
  });

  it("rejects blank task text and never emits ids when creating tasks", () => {
    expect(() => createTodoLine({
      text: "   ",
      labels: [],
      created: "2026-07-10",
    })).toThrow();
    expect(createTodoLine({
      text: "Read book",
      labels: ["#home"],
      created: "2026-07-10",
    })).not.toContain("🆔");
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

  it("does not add #todo to existing bare tasks when patching labels", () => {
    const parsed = parseTodoLine("- [ ] Call Alice #work 📅 2026-07-20")!;
    expect(patchTodoLine(parsed, { labels: ["phone"] }, "2026-07-10"))
      .toBe("- [ ] Call Alice #phone 📅 2026-07-20");
  });

  it("sets and clears due date and priority independently", () => {
    const parsed = parseTodoLine("- [ ] File taxes #todo #private ➕ 2026-07-10")!;
    const set = patchTodoLine(parsed, { due: "2026-07-31", priority: "highest" }, "2026-07-10");
    expect(set).toBe("- [ ] File taxes #todo #private 🔺 📅 2026-07-31 ➕ 2026-07-10");
    expect(patchTodoLine(parseTodoLine(set)!, { due: null, priority: null }, "2026-07-10"))
      .toBe("- [ ] File taxes #todo #private ➕ 2026-07-10");
  });

  it("rejects empty patches and read-only statuses", () => {
    const parsed = parseTodoLine("- [ ] Keep it")!;
    expect(() => patchTodoLine(parsed, {}, "2026-07-10")).toThrow();
    expect(() => patchTodoLine(parseTodoLine("- [/] Locked task #todo")!, { labels: ["work"] }, "2026-07-10"))
      .toThrow();
  });

  it("preserves untouched known token spelling/order and unknown metadata when patching one field", () => {
    const parsed = parseTodoLine("- [ ] Renew subscription #todo 📅   2026-07-20 ➕\t2026-07-10 🔁 every week 🆔 rel-7")!;
    expect(patchTodoLine(parsed, { priority: "high" }, "2026-07-10"))
      .toBe("- [ ] Renew subscription #todo ⏫ 📅   2026-07-20 ➕\t2026-07-10 🔁 every week 🆔 rel-7");
  });

  it("replaces duplicate target metadata with one canonical token", () => {
    const parsed = parseTodoLine("- [ ] Pay rent #todo 📅 2026-07-01 📅 2026-07-02 ➕ 2026-07-10")!;
    expect(patchTodoLine(parsed, { due: "2026-07-31" }, "2026-07-10"))
      .toBe("- [ ] Pay rent #todo 📅 2026-07-31 ➕ 2026-07-10");
  });
});
