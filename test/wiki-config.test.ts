import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWikiConfig, loadWikiConfig } from "../src/wiki/config.js";

describe("parseWikiConfig", () => {
  it("reads title and footer", () => {
    expect(parseWikiConfig('title: My Docs\nfooter: (c) Acme\n')).toEqual({ title: "My Docs", footer: "(c) Acme" });
  });
  it("strips surrounding quotes", () => {
    expect(parseWikiConfig('title: "Quoted Title"')).toEqual({ title: "Quoted Title" });
  });
  it("ignores unknown keys and blanks", () => {
    expect(parseWikiConfig("\n# comment\nother: x\ntitle: T\n")).toEqual({ title: "T" });
  });
  it("returns empty for empty text", () => {
    expect(parseWikiConfig("")).toEqual({});
  });
});

describe("loadWikiConfig", () => {
  it("returns {} when file missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcfg-"));
    expect(await loadWikiConfig(dir)).toEqual({});
  });
  it("loads .okh/wiki.yml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wcfg-"));
    await mkdir(join(dir, ".okh"), { recursive: true });
    await writeFile(join(dir, ".okh", "wiki.yml"), "title: Widgets KB\n");
    expect(await loadWikiConfig(dir)).toEqual({ title: "Widgets KB" });
  });
});
