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
      await saveModuleManifest(dir, { type: "knowledge", description: "team kb", config: {} });
      expect(await moduleManifestExists(dir)).toBe(true);
      const m = await loadModuleManifest(dir);
      expect(m).toEqual({ type: "knowledge", description: "team kb", config: {} });
      const raw = await readFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "utf8");
      expect(raw).toContain("type: knowledge");
      expect(raw).not.toContain("name:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a custom (unknown) type string", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, MODULE_OKH_DIR), { recursive: true });
      await writeFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "type: recipes\ndescription: my food\n");
      const m = await loadModuleManifest(dir);
      expect(m.type).toBe("recipes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("strips a legacy name key on read (older manifests keep loading)", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, MODULE_OKH_DIR), { recursive: true });
      await writeFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "type: knowledge\nname: KB\ndescription: team kb\n");
      const m = await loadModuleManifest(dir);
      expect(m).toEqual({ type: "knowledge", description: "team kb" });
      expect("name" in m).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a missing description on read (defaults to empty)", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, MODULE_OKH_DIR), { recursive: true });
      await writeFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "type: knowledge\n");
      const m = await loadModuleManifest(dir);
      expect(m).toEqual({ type: "knowledge", description: "" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a manifest missing the required type field", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, MODULE_OKH_DIR), { recursive: true });
      await writeFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "description: no type here\n");
      await expect(loadModuleManifest(dir)).rejects.toThrow(/INVALID_MANIFEST|type/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown key other than the legacy name", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, MODULE_OKH_DIR), { recursive: true });
      await writeFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "type: knowledge\nbogus: nope\n");
      await expect(loadModuleManifest(dir)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds a manifest with defaults", () => {
    const m = scaffoldModuleManifest("memory", "");
    expect(m).toEqual({ type: "memory", description: "" });
  });

  it("round-trips the wiki-sync keys", async () => {
    const dir = await tmp();
    try {
      await saveModuleManifest(dir, {
        type: "knowledge",
        description: "kb",
        "wiki-sync": true,
        "wiki-sync-reverse-mode": "direct",
        "wiki-sync-expanded": true,
      });
      const m = await loadModuleManifest(dir);
      expect(m["wiki-sync"]).toBe(true);
      expect(m["wiki-sync-reverse-mode"]).toBe("direct");
      expect(m["wiki-sync-expanded"]).toBe(true);
      const raw = await readFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "utf8");
      expect(raw).toContain("wiki-sync: true");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a manifest without the wiki-sync keys (both optional)", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, MODULE_OKH_DIR), { recursive: true });
      await writeFile(join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME), "type: knowledge\ndescription: kb\n");
      const m = await loadModuleManifest(dir);
      expect(m["wiki-sync"]).toBeUndefined();
      expect(m["wiki-sync-reverse-mode"]).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid wiki-sync-reverse-mode value", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, MODULE_OKH_DIR), { recursive: true });
      await writeFile(
        join(dir, MODULE_OKH_DIR, MODULE_MANIFEST_BASENAME),
        "type: knowledge\nwiki-sync: true\nwiki-sync-reverse-mode: bogus\n",
      );
      await expect(loadModuleManifest(dir)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
