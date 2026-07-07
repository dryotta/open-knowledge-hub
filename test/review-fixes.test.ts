import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { resolvePaths } from "../src/config.js";
import { loadRegistry, findContainer } from "../src/registry/registry.js";

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "okh-home-"));
  const root = await mkdtemp(join(tmpdir(), "okh-c-"));
  const paths = resolvePaths({ OKH_HOME: home });
  const svc = new ContainerService(paths);
  return { home, root, paths, svc };
}

async function registerLegacy(paths: ReturnType<typeof resolvePaths>, root: string, sync: string) {
  // A legacy container: registry entry (sync defaults to auto) + a legacy .okh/okh.yaml carrying the real sync.
  const { saveRegistry } = await import("../src/registry/registry.js");
  await saveRegistry(paths, {
    version: 1,
    containers: [{ name: "legacy", backend: "local", localPath: root, sync: "auto", addedAt: new Date().toISOString() }],
  });
  await mkdir(join(root, ".okh"), { recursive: true });
  await mkdir(join(root, "kb"), { recursive: true });
  await writeFile(join(root, ".okh", "okh.yaml"), `name: legacy\nsync: ${sync}\nmodules:\n  - path: kb\n    type: knowledge\n`);
}

describe("legacy sync is persisted to the registry on read (not silently downgraded)", () => {
  it("status() migrates a legacy sync: pr into the registry entry", async () => {
    const { paths, root, svc } = await setup();
    try {
      await registerLegacy(paths, root, "pr");
      const st = await svc.status("legacy");
      expect(st.sync).toBe("pr");
      // legacy file is gone, and the pr mode now lives on the registry entry
      await expect(stat(join(root, ".okh", "okh.yaml"))).rejects.toThrow();
      const entry = findContainer(await loadRegistry(paths), "legacy");
      expect(entry!.sync).toBe("pr");
    } finally {
      await rm(paths.home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolveTargets() also persists the migrated sync", async () => {
    const { paths, root, svc } = await setup();
    try {
      await registerLegacy(paths, root, "pr");
      const targets = await svc.resolveTargets("legacy");
      expect(targets[0]!.sync).toBe("pr");
      const entry = findContainer(await loadRegistry(paths), "legacy");
      expect(entry!.sync).toBe("pr");
    } finally {
      await rm(paths.home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a module cannot be created at the container root", () => {
  it("rejects add module with path '.'", async () => {
    const { paths, root, svc } = await setup();
    try {
      const { saveRegistry } = await import("../src/registry/registry.js");
      await saveRegistry(paths, {
        version: 1,
        containers: [{ name: "h", backend: "local", localPath: root, sync: "auto", addedAt: new Date().toISOString() }],
      });
      await expect(
        svc.addModule({ container: "h", path: ".", type: "knowledge", name: "root", create: true }),
      ).rejects.toThrow(/root|relative|\.\./i);
    } finally {
      await rm(paths.home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
