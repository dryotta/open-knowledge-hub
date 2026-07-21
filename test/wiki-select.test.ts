import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectWikiModules } from "../src/wiki/select.js";
import { saveModuleManifest, type ModuleManifest } from "../src/modules/manifest.js";

async function repoWith(mods: Record<string, ModuleManifest>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "okh-select-"));
  for (const [name, manifest] of Object.entries(mods)) {
    await mkdir(join(dir, name), { recursive: true });
    await saveModuleManifest(join(dir, name), manifest);
  }
  return dir;
}

describe("selectWikiModules", () => {
  it("returns every flagged module, of any type, sorted alphabetically", async () => {
    const dir = await repoWith({
      telemetry: { type: "knowledge", description: "T", "wiki-sync": true },
      playbooks: { type: "skills", description: "P", "wiki-sync": true } as ModuleManifest,
      skipped: { type: "knowledge", description: "O" },
    });
    try {
      const sel = await selectWikiModules(dir);
      expect(sel.map((m) => m.name)).toEqual(["playbooks", "telemetry"]);
      expect(sel[0].moduleRoot).toBe(join(dir, "playbooks"));
      expect(sel[0].reverseMode).toBe("pr");
      expect(sel[0].expanded).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves reverse mode and expand override from the manifest", async () => {
    const dir = await repoWith({
      a: {
        type: "knowledge",
        description: "A",
        "wiki-sync": true,
        "wiki-sync-reverse-mode": "direct",
        "wiki-sync-expanded": true,
      },
    });
    try {
      const [m] = await selectWikiModules(dir);
      expect(m.reverseMode).toBe("direct");
      expect(m.expanded).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats an absent flag and wiki-sync: false identically — both stay opt-out", async () => {
    const dir = await repoWith({
      on: { type: "knowledge", description: "on", "wiki-sync": true },
      off: { type: "knowledge", description: "off", "wiki-sync": false },
      absent: { type: "knowledge", description: "absent" },
    });
    try {
      const sel = await selectWikiModules(dir);
      expect(sel.map((m) => m.name)).toEqual(["on"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects when no module is flagged", async () => {
    const dir = await repoWith({
      telemetry: { type: "knowledge", description: "T" },
      skills: { type: "skills", description: "S" },
    });
    try {
      await expect(selectWikiModules(dir)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
