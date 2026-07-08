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
  it("finds nested module manifests and returns POSIX paths sorted", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-disc-"));
    try {
      await writeManifest(root, "kb", "type: knowledge\nname: KB\ndescription: d\n");
      await writeManifest(root, join("nested", "mem"), "type: memory\nname: M\ndescription: d\n");
      await mkdir(join(root, ".git"), { recursive: true });
      await writeManifest(root, ".git", "type: knowledge\nname: X\ndescription: d\n"); // must be ignored
      const mods = await discoverModules(root);
      expect(mods.map((m) => m.path)).toEqual(["kb", "nested/mem"]);
      expect(mods[0]!.manifest.type).toBe("knowledge");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not descend into a discovered module", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-disc-"));
    try {
      await writeManifest(root, "outer", "type: custom\nname: O\ndescription: d\n");
      await writeManifest(root, join("outer", "inner"), "type: memory\nname: I\ndescription: d\n");
      const mods = await discoverModules(root);
      expect(mods.map((m) => m.path)).toEqual(["outer"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records an invalid manifest instead of throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-disc-"));
    try {
      await writeManifest(root, "bad", "type: knowledge\n"); // missing name
      const mods = await discoverModules(root);
      expect(mods).toHaveLength(1);
      expect(mods[0]!.error).toMatch(/name/i);
      expect(mods[0]!.manifest).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
