import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectWikiModule } from "../src/wiki/select.js";
import { saveModuleManifest, type ModuleManifest } from "../src/modules/manifest.js";

async function repoWith(mods: Record<string, ModuleManifest>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "okh-select-"));
  for (const [name, manifest] of Object.entries(mods)) {
    await mkdir(join(dir, name), { recursive: true });
    await saveModuleManifest(join(dir, name), manifest);
  }
  return dir;
}

describe("selectWikiModule", () => {
  it("returns the sole knowledge module flagged wiki-sync: true", async () => {
    const dir = await repoWith({
      telemetry: { type: "knowledge", description: "T", "wiki-sync": true },
      skills: { type: "skills", description: "S" },
      other: { type: "knowledge", description: "O" },
    });
    try {
      const sel = await selectWikiModule(dir);
      expect(sel.name).toBe("telemetry");
      expect(sel.moduleRoot).toBe(join(dir, "telemetry"));
      expect(sel.reverseMode).toBe("pr");
      expect(sel.manifest.type).toBe("knowledge");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves the reverse mode from the manifest, defaulting to pr", async () => {
    const dir = await repoWith({
      a: { type: "knowledge", description: "A", "wiki-sync": true, "wiki-sync-reverse-mode": "direct" },
    });
    try {
      expect((await selectWikiModule(dir)).reverseMode).toBe("direct");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects when no knowledge module is flagged", async () => {
    const dir = await repoWith({
      telemetry: { type: "knowledge", description: "T" },
      skills: { type: "skills", description: "S", "wiki-sync": true } as ModuleManifest,
    });
    try {
      await expect(selectWikiModule(dir)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects when more than one knowledge module is flagged (flat namespace)", async () => {
    const dir = await repoWith({
      a: { type: "knowledge", description: "A", "wiki-sync": true },
      b: { type: "knowledge", description: "B", "wiki-sync": true },
    });
    try {
      await expect(selectWikiModule(dir)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
