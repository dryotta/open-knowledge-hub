import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadModuleManifest,
  saveModuleManifest,
  moduleManifestExists,
  scaffoldModuleManifest,
  MODULE_OKH_DIR,
  MODULE_MANIFEST_BASENAME,
} from "../src/modules/manifest.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "okh-mm-"));
}

describe("module manifest", () => {
  it("round-trips a valid manifest", async () => {
    const dir = await tmp();
    try {
      await saveModuleManifest(dir, { type: "knowledge", name: "KB", description: "team kb", config: {} });
      expect(await moduleManifestExists(dir)).toBe(true);
      const m = await loadModuleManifest(dir);
      expect(m).toEqual({ type: "knowledge", name: "KB", description: "team kb", config: {} });
      const raw = await readFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "utf8");
      expect(raw).toContain("type: knowledge");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a custom (unknown) type string", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, MODULE_OKH_DIR), { recursive: true });
      await writeFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "type: recipes\nname: Recipes\ndescription: my food\n");
      const m = await loadModuleManifest(dir);
      expect(m.type).toBe("recipes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a manifest missing required fields", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, MODULE_OKH_DIR), { recursive: true });
      await writeFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "type: knowledge\n");
      await expect(loadModuleManifest(dir)).rejects.toThrow(/INVALID_MANIFEST|name/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds a manifest with defaults", () => {
    const m = scaffoldModuleManifest("memory", "notes", "");
    expect(m).toEqual({ type: "memory", name: "notes", description: "" });
  });
});
