import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile, mkdir, readFile } from "node:fs/promises";
import {
  loadManifest,
  saveManifest,
  withPackAdded,
  withPackUpdated,
  withPackRemoved,
  requirePack,
  findPack,
} from "../src/catalog/manifest.js";
import { emptyManifest, type PackEntry } from "../src/catalog/schema.js";
import { OkhError } from "../src/errors.js";
import { makePaths, makeTempDir } from "./helpers.js";

const entry = (slug: string): PackEntry => ({
  slug,
  repoUrl: `https://example.com/${slug}.git`,
  state: "registered",
  addedAt: "2026-01-01T00:00:00.000Z",
});

const dirs: string[] = [];
async function tmpPaths() {
  const home = await makeTempDir();
  dirs.push(home);
  return makePaths(home);
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("manifest load/save", () => {
  it("treats a missing file as an empty catalog", async () => {
    const paths = await tmpPaths();
    expect(await loadManifest(paths)).toEqual(emptyManifest());
  });

  it("round-trips through disk", async () => {
    const paths = await tmpPaths();
    const m = withPackAdded(emptyManifest(), entry("alpha"));
    await saveManifest(paths, m);
    expect(await loadManifest(paths)).toEqual(m);
  });

  it("rejects invalid JSON", async () => {
    const paths = await tmpPaths();
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.manifestFile, "{ not json", "utf8");
    await expect(loadManifest(paths)).rejects.toBeInstanceOf(OkhError);
  });

  it("rejects a schema-invalid manifest", async () => {
    const paths = await tmpPaths();
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.manifestFile, JSON.stringify({ version: 1, packs: [{ slug: "X!" }] }), "utf8");
    await expect(loadManifest(paths)).rejects.toBeInstanceOf(OkhError);
  });

  it("writes atomically (pretty JSON, trailing newline)", async () => {
    const paths = await tmpPaths();
    await saveManifest(paths, withPackAdded(emptyManifest(), entry("alpha")));
    const raw = await readFile(paths.manifestFile, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('"slug": "alpha"');
  });
});

describe("manifest mutations", () => {
  it("adds and finds packs", () => {
    const m = withPackAdded(emptyManifest(), entry("alpha"));
    expect(findPack(m, "alpha")?.slug).toBe("alpha");
    expect(requirePack(m, "alpha").slug).toBe("alpha");
  });

  it("rejects duplicate slugs", () => {
    const m = withPackAdded(emptyManifest(), entry("alpha"));
    expect(() => withPackAdded(m, entry("alpha"))).toThrow(OkhError);
  });

  it("updates an entry", () => {
    const m = withPackAdded(emptyManifest(), entry("alpha"));
    const m2 = withPackUpdated(m, "alpha", (e) => ({ ...e, state: "installed" }));
    expect(findPack(m2, "alpha")?.state).toBe("installed");
  });

  it("removes an entry", () => {
    const m = withPackAdded(emptyManifest(), entry("alpha"));
    expect(withPackRemoved(m, "alpha").packs).toHaveLength(0);
  });

  it("throws NOT_FOUND for missing slugs", () => {
    expect(() => requirePack(emptyManifest(), "ghost")).toThrow(OkhError);
    expect(() => withPackRemoved(emptyManifest(), "ghost")).toThrow(OkhError);
    expect(() => withPackUpdated(emptyManifest(), "ghost", (e) => e)).toThrow(OkhError);
  });
});
