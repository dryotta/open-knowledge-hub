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
