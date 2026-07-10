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

  it("keeps an id token from overlapping a nested label", () => {
    const parsed = parseTodoLine("- [ ] Task 🆔 #work");
    expect(parsed).toMatchObject({
      text: "Task",
      id: "#work",
      labels: [],
    });
    expect(parsed?.tokens).toHaveLength(1);
    expect(parsed?.tokens[0]).toMatchObject({
      kind: "id",
      raw: "🆔 #work",
      value: "#work",
    });
  });

  it("keeps an id token from overlapping a nested priority", () => {
    const parsed = parseTodoLine("- [ ] Task 🆔 🔼");
    expect(parsed).toMatchObject({
      text: "Task",
      id: "🔼",
      priority: "normal",
      labels: [],
    });
    expect(parsed?.tokens).toHaveLength(1);
    expect(parsed?.tokens[0]).toMatchObject({
      kind: "id",
      raw: "🆔 🔼",
      value: "🔼",
    });
  });

  it("keeps an invalid due token from overlapping a nested label", () => {
    const parsed = parseTodoLine("- [ ] Task 📅 #work");
    expect(parsed).toMatchObject({
      text: "Task",
      due: undefined,
      labels: [],
    });
    expect(parsed?.warnings).toContain('Invalid due date "#work".');
    expect(parsed?.tokens).toHaveLength(1);
    expect(parsed?.tokens[0]).toMatchObject({
      kind: "due",
      raw: "📅 #work",
      value: "#work",
      valid: false,
    });
  });

  it("keeps malformed completed metadata visible and reports warnings", () => {
    const parsed = parseTodoLine("- [ ] keep ✅ done");
    expect(parsed).toMatchObject({
      text: "keep",
      completed: undefined,
    });
    expect(parsed?.warnings).toContain('Invalid completed date "done".');
    expect(parsed?.tokens).toHaveLength(1);
    expect(parsed?.tokens[0]).toMatchObject({
      kind: "completed",
      raw: "✅ done",
      value: "done",
      valid: false,
    });
  });

  it("treats embedded metadata-like text as ordinary text unless separated by whitespace", () => {
    const parsed = parseTodoLine("- [ ] Keep C🔼 A✅2026-07-10 and 🆔badge");
    expect(parsed).toMatchObject({
      text: "Keep C🔼 A✅2026-07-10 and 🆔badge",
      priority: "normal",
      completed: undefined,
      id: undefined,
      warnings: [],
    });
  });

  it("does not tokenize hashtags inside words and preserves markdown spacing", () => {
    const parsed = parseTodoLine("- [ ] Support C#interop and **keep  spacing** #work");
    expect(parsed?.text).toBe("Support C#interop and **keep  spacing**");
    expect(parsed?.labels).toEqual(["work"]);
    expect(parsed?.tokens.some((token) => token.kind === "label" && token.raw === "#interop")).toBe(false);
  });

  it("keeps token spans body-relative and exact", () => {
    const parsed = parseTodoLine("- [ ] #work 📅 2026-07-11");
    expect(parsed).toBeDefined();
    expect(parsed).not.toBeUndefined();
    for (const token of parsed!.tokens) {
      expect(parsed!.body.slice(token.start, token.end)).toBe(token.raw);
    }
  });

  it("keeps the last valid due date and warns on duplicate and invalid duplicates", () => {
    const duplicateValid = parseTodoLine("- [ ] Repeat 📅 2026-07-11 📅 2026-07-12");
    expect(duplicateValid).toMatchObject({
      due: "2026-07-12",
    });
    expect(duplicateValid?.warnings).toContain(
      "Duplicate due date metadata found; using the last valid value.",
    );

    const invalidDuplicate = parseTodoLine("- [ ] Repeat 📅 2026-07-11 📅 someday");
    expect(invalidDuplicate).toMatchObject({
      due: "2026-07-11",
    });
    expect(invalidDuplicate?.warnings).toContain(
      "Duplicate due date metadata found; using the last valid value.",
    );
    expect(invalidDuplicate?.warnings).toContain('Invalid due date "someday".');
  });

  it("preserves unrelated internal whitespace when removing metadata", () => {
    const parsed = parseTodoLine("- [ ] Preserve  this #work 📅 2026-07-11");
    expect(parsed?.text).toBe("Preserve  this");
  });

  it("returns undefined for ordinary prose", () => {
    expect(parseTodoLine("Remember to buy milk.")).toBeUndefined();
  });
});
