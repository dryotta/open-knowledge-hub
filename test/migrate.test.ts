import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyContainerManifest, removeLegacyContainerManifest } from "../src/container/migrate.js";
import { loadModuleManifest } from "../src/modules/manifest.js";

describe("migrateLegacyContainerManifest", () => {
  it("writes per-module manifests and returns sync, but leaves the legacy file in place", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-mig-"));
    try {
      await mkdir(join(root, ".okh"), { recursive: true });
      await mkdir(join(root, "kb"), { recursive: true });
      await writeFile(join(root, ".okh", "okh.yaml"),
        "name: h\nsync: pr\nmodules:\n  - path: kb\n    type: knowledge\n");
      const sync = await migrateLegacyContainerManifest(root);
      expect(sync).toBe("pr");
      const m = await loadModuleManifest(join(root, "kb"));
      expect(m.type).toBe("knowledge");
      expect(m.name).toBe("kb");
      // legacy file must NOT be deleted by migrateLegacyContainerManifest
      await expect(stat(join(root, ".okh", "okh.yaml"))).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is a no-op when there is no legacy manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-mig-"));
    try {
      expect(await migrateLegacyContainerManifest(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves a syntactically malformed legacy file alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-mig-"));
    try {
      await mkdir(join(root, ".okh"), { recursive: true });
      await writeFile(join(root, ".okh", "okh.yaml"), "modules: [oops\n  - bad: :\n");
      expect(await migrateLegacyContainerManifest(root)).toBeUndefined();
      // malformed file is preserved, not deleted
      await expect(stat(join(root, ".okh", "okh.yaml"))).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("removeLegacyContainerManifest", () => {
  it("deletes the legacy file", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-mig-"));
    try {
      await mkdir(join(root, ".okh"), { recursive: true });
      await writeFile(join(root, ".okh", "okh.yaml"), "name: h\nsync: auto\nmodules: []\n");
      await removeLegacyContainerManifest(root);
      await expect(stat(join(root, ".okh", "okh.yaml"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is a no-op when the legacy file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "okh-mig-"));
    try {
      await expect(removeLegacyContainerManifest(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
