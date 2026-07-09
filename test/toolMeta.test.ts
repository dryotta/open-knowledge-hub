import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseToolMeta, describeShape } from "../src/server/toolMeta.js";

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
