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

  it("captures full Unicode custom checkbox statuses as read-only", () => {
    expect(parseTodoLine("- [🔥] Task")).toMatchObject({
      status: "custom",
      statusChar: "🔥",
      readOnly: true,
      text: "Task",
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

  it("preserves trailing punctuation on ids while keeping the id value clean", () => {
    expect(parseTodoLine("- [ ] Task 🆔 abc123, more text")).toMatchObject({
      id: "abc123",
      text: "Task, more text",
    });
  });

  it("parses priority emoji followed by punctuation without swallowing it", () => {
    expect(parseTodoLine("- [ ] Task 🔼, next")).toMatchObject({
      priority: "medium",
      text: "Task, next",
    });
    expect(parseTodoLine("- [ ] Task 🔼, next")?.tokens).toMatchObject([
      {
        kind: "priority",
        raw: "🔼",
        value: "medium",
      },
    ]);
  });

  it("parses priority emoji followed by Unicode punctuation without swallowing it", () => {
    expect(parseTodoLine("- [ ] Task 🔼) next")).toMatchObject({
      priority: "medium",
      text: "Task) next",
    });
    expect(parseTodoLine("- [ ] Task 🔼” next")).toMatchObject({
      priority: "medium",
      text: "Task” next",
    });
  });

  it("does not parse priority emoji when it touches a word", () => {
    expect(parseTodoLine("- [ ] 🔼momentum")).toMatchObject({
      priority: "normal",
      text: "🔼momentum",
      tokens: [],
    });
  });

  it("preserves trailing punctuation on created dates while keeping the date value clean", () => {
    expect(parseTodoLine("- [ ] Note ➕ 2026-07-11: details")).toMatchObject({
      created: "2026-07-11",
      text: "Note: details",
    });
  });

  it("keeps exact spans for dated metadata with multiple separator spaces", () => {
    const parsed = parseTodoLine("- [ ] Task 📅   2026-07-11");
    expect(parsed).toMatchObject({
      due: "2026-07-11",
      text: "Task",
    });
    expect(parsed?.tokens).toHaveLength(1);
    expect(parsed?.tokens[0]).toMatchObject({
      kind: "due",
      raw: "📅   2026-07-11",
      value: "2026-07-11",
    });
    expect(parsed?.body.slice(parsed.tokens[0].start, parsed.tokens[0].end)).toBe(
      parsed.tokens[0].raw,
    );
  });

  it("keeps exact spans for id metadata with a tab separator", () => {
    const parsed = parseTodoLine("- [ ] Task 🆔	abc123, more text");
    expect(parsed).toMatchObject({
      id: "abc123",
      text: "Task, more text",
    });
    expect(parsed?.tokens).toHaveLength(1);
    expect(parsed?.tokens[0]).toMatchObject({
      kind: "id",
      raw: "🆔	abc123",
      value: "abc123",
    });
    expect(parsed?.body.slice(parsed.tokens[0].start, parsed.tokens[0].end)).toBe(
      parsed.tokens[0].raw,
    );
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

  it("preserves body spacing adjacent to removed authored metadata", () => {
    expect(parseTodoLine("- [ ] Alpha #work  beta")).toMatchObject({
      text: "Alpha  beta",
      labels: ["work"],
    });
  });

  it("removes metadata without damaging punctuation or trailing whitespace", () => {
    expect(parseTodoLine("- [ ] Do #work, now")).toMatchObject({
      text: "Do, now",
      labels: ["work"],
    });
    expect(parseTodoLine("- [ ] Buy milk  ")).toMatchObject({
      text: "Buy milk",
    });
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
