import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseToolMeta, describeShape, loadToolMeta } from "../src/server/toolMeta.js";
import { toolShapes, type ToolName } from "../src/server/toolSchemas.js";
import type { RenderContext } from "../src/prompts/templates.js";

function normalizedWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("parseToolMeta", () => {
  it("parses title + args and renders the body as description", async () => {
    const raw = "---\ntitle: T\nargs:\n  a: desc-a\n---\nHello body.\n";
    const m = await parseToolMeta("x", raw);
    expect(m.title).toBe("T");
    expect(m.args).toEqual({ a: "desc-a" });
    expect(m.description).toBe("Hello body.");
  });
  it("renders {{var:...}} tokens in the body", async () => {
    const raw = "---\ntitle: Config\n---\nKnown keys: {{var:configKeys}}.\n";
    const m = await parseToolMeta("config", raw, { vars: { configKeys: "wakePhrase" } });
    expect(m.description).toBe("Known keys: wakePhrase.");
  });
  it("defaults args to {} when absent", async () => {
    const m = await parseToolMeta("x", "---\ntitle: T\n---\nBody.\n");
    expect(m.args).toEqual({});
  });
  it("throws on a missing title", async () => {
    await expect(parseToolMeta("x", "---\nargs: {}\n---\nBody.\n")).rejects.toThrow(/title/);
  });
  it("throws on an empty description body", async () => {
    await expect(parseToolMeta("x", "---\ntitle: T\n---\n\n")).rejects.toThrow(/description/);
  });
  it("throws on a non-string arg description", async () => {
    await expect(parseToolMeta("x", "---\ntitle: T\nargs:\n  a: 3\n---\nBody.\n")).rejects.toThrow(/arg "a"/);
  });
});

describe("describeShape", () => {
  it("applies descriptions to each field", () => {
    const shaped = describeShape({ a: z.string(), b: z.number() }, { a: "da", b: "db" });
    expect(shaped.a!.description).toBe("da");
    expect(shaped.b!.description).toBe("db");
  });
  it("throws when an arg lacks a description", () => {
    expect(() => describeShape({ a: z.string() }, {})).toThrow(/mismatch/);
  });
  it("throws on an orphan description", () => {
    expect(() => describeShape({}, { a: "da" })).toThrow(/mismatch/);
  });
});

describe("every tool has complete, consistent metadata", () => {
  const ctxFor = (name: ToolName): RenderContext | undefined =>
    name === "config" ? { vars: { configKeys: "wakePhrase" } } : undefined;

  for (const name of Object.keys(toolShapes) as ToolName[]) {
    it(`"${name}" resource loads and its args match its schema`, async () => {
      const m = await loadToolMeta(name, ctxFor(name));
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
      expect(() => describeShape(toolShapes[name], m.args)).not.toThrow();
    });
  }

  it("documents the unified todos API without a separate update tool", async () => {
    expect(Object.keys(toolShapes)).not.toContain("update_todo");

    const todos = await loadToolMeta("todos");
    const description = normalizedWhitespace(todos.description);
    expect(description).toContain("List, preview, create, or update Markdown todos in memory modules.");
    expect(description).toContain("Create and update return a preview without writing unless `apply: true` is supplied.");
    expect(todos.args.operation).toContain("defaults to `list`");
  });

  it("sync schema includes action arg and metadata describes it", async () => {
    expect(toolShapes.sync).toHaveProperty("action");
    const sync = await loadToolMeta("sync");
    expect(sync.args).toHaveProperty("action");
    expect(sync.args.action).toMatch(/publish-pr|action|container/i);
  });

  it("add_container sync arg documents structured {mode, config} form", async () => {
    const addContainer = await loadToolMeta("add_container");
    expect(addContainer.args.sync).toMatch(/mode|shared|auto/i);
    // Must not document the legacy "pr" string as a valid mode value
    expect(addContainer.args.sync).not.toMatch(/"pr"/);
  });

  it("flow arguments preserve user scope without inferred expansion", async () => {
    const context = await loadToolMeta("context");
    const ask = await loadToolMeta("ask");
    expect(context.args.task).toMatch(/copied without adding inferred requirements/i);
    expect(ask.args.question).toMatch(/copied without weakening or expanding/i);
  });
});
