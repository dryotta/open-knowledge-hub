import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModules } from "../src/modules/discovery.js";

async function writeManifest(root: string, rel: string, body: string): Promise<void> {
  await mkdir(join(root, rel, ".okh"), { recursive: true });
  await writeFile(join(root, rel, ".okh", "module.yaml"), body);
}

describe("discoverModules", () => {
  it("finds only top-level module manifests and returns POSIX paths sorted", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-disc-"));
    try {
      await writeManifest(root, "kb", "type: knowledge\ndescription: d\n");
      await writeManifest(root, "mem", "type: memory\ndescription: d\n");
      await mkdir(join(root, ".git"), { recursive: true });
      await writeManifest(root, ".git", "type: knowledge\ndescription: d\n"); // must be ignored
      const mods = await discoverModules(root);
      expect(mods.map((m) => m.path)).toEqual(["kb", "mem"]);
      expect(mods[0]!.manifest?.type).toBe("knowledge");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flags a nested manifest as misplaced instead of treating it as a module", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-disc-"));
    try {
      await writeManifest(root, "kb", "type: knowledge\ndescription: d\n");
      await writeManifest(root, join("nested", "mem"), "type: memory\ndescription: d\n");
      const mods = await discoverModules(root);
      expect(mods.map((m) => m.path)).toEqual(["kb", "nested/mem"]);
      const misplaced = mods.find((m) => m.path === "nested/mem");
      expect(misplaced!.manifest).toBeUndefined();
      expect(misplaced!.error).toMatch(/top-level/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not descend into a discovered top-level module", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-disc-"));
    try {
      await writeManifest(root, "outer", "type: custom\ndescription: d\n");
      await writeManifest(root, join("outer", "inner"), "type: memory\ndescription: d\n");
      const mods = await discoverModules(root);
      expect(mods.map((m) => m.path)).toEqual(["outer"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records an invalid manifest instead of throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-disc-"));
    try {
      await writeManifest(root, "bad", "description: no type here\n"); // missing required type
      const mods = await discoverModules(root);
      expect(mods).toHaveLength(1);
      expect(mods[0]!.error).toMatch(/INVALID_MANIFEST|type/i);
      expect(mods[0]!.manifest).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
