import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { resolvePaths } from "../src/config.js";
import { loadRegistry, findContainer } from "../src/registry/registry.js";
import { makeOrigin, testRun } from "./helpers.js";

class FakeGh {
  loginResult: string = "alice";
  async currentLogin(): Promise<string> { return this.loginResult; }
  async findOpenPr(): Promise<string | undefined> { return undefined; }
  async createRepo(): Promise<string> { return "x"; }
  async createPr(): Promise<string> { return "https://github.com/test/x/pull/1"; }
}

async function setup(loginResult = "alice") {
  const home = await mkdtemp(join(tmpdir(), "okh-home-"));
  const root = await mkdtemp(join(tmpdir(), "okh-c-"));
  const paths = resolvePaths({ OKH_HOME: home });
  const gh = new FakeGh();
  gh.loginResult = loginResult;
  const svc = new ContainerService(paths, new Git(testRun), gh as unknown as Gh);
  return { home, root, paths, svc, gh };
}

async function registerLegacy(paths: ReturnType<typeof resolvePaths>, root: string, sync: string) {
  // Write a v1 registry JSON directly so loadRegistry can auto-migrate it to v2.
  await mkdir(dirname(paths.registryFile), { recursive: true });
  await writeFile(paths.registryFile, JSON.stringify({
    version: 1,
    containers: [{ name: "legacy", backend: "local", localPath: root, sync: "auto", addedAt: new Date().toISOString() }],
  }));
  await mkdir(join(root, ".okh"), { recursive: true });
  await mkdir(join(root, "kb"), { recursive: true });
  await writeFile(join(root, ".okh", "okh.yaml"), `name: legacy\nsync: ${sync}\nmodules:\n  - path: kb\n    type: knowledge\n`);
}

async function registerLegacyGit(
  paths: ReturnType<typeof resolvePaths>,
  root: string,
  origin: string,
  sync: string,
) {
  await mkdir(dirname(paths.registryFile), { recursive: true });
  await writeFile(paths.registryFile, JSON.stringify({
    version: 1,
    containers: [{ name: "hub", backend: "git", origin, localPath: root, sync, addedAt: new Date().toISOString() }],
  }));
  await mkdir(join(root, ".okh"), { recursive: true });
  await writeFile(join(root, ".okh", "okh.yaml"), `name: hub\nsync: ${sync}\nmodules: []\n`);
}

describe("legacy sync is persisted to the registry on read", () => {
  it("status() migrates a legacy local sync: pr to auto in the registry entry", async () => {
    const { paths, root, svc } = await setup();
    try {
      await registerLegacy(paths, root, "pr");
      const st = await svc.status("legacy");
      // local backend "pr" migrates to "auto" under v2 rules
      expect(st.sync?.mode).toBe("auto");
      // legacy file is gone
      await expect(stat(join(root, ".okh", "okh.yaml"))).rejects.toThrow();
      const entry = findContainer(await loadRegistry(paths), "legacy");
      expect(entry!.sync.mode).toBe("auto");
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
      expect(targets[0]!.sync.mode).toBe("auto");
      const entry = findContainer(await loadRegistry(paths), "legacy");
      expect(entry!.sync.mode).toBe("auto");
    } finally {
      await rm(paths.home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("legacy git pr .okh manifest migrates to shared branch and removes file", async () => {
    const origin = await makeOrigin({ "README.md": "# origin\n" });
    const originParent = dirname(origin);
    const root = await mkdtemp(join(tmpdir(), "okh-git-c-"));
    const { paths, root: setupRoot, svc } = await setup("bob");
    try {
      // Clone the origin so the local path is a real git repo
      await new Git(testRun).clone(origin, root);
      await registerLegacyGit(paths, root, origin, "pr");
      const st = await svc.status("hub");
      expect(st.sync?.mode).toBe("shared");
      expect((st.sync?.config as Record<string, unknown>)?.["branch"]).toBe("user/bob/hub");
      // legacy file removed after successful save
      await expect(stat(join(root, ".okh", "okh.yaml"))).rejects.toThrow();
      const entry = findContainer(await loadRegistry(paths), "hub");
      expect(entry!.sync.config["branch"]).toBe("user/bob/hub");
    } finally {
      await rm(paths.home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
      await rm(setupRoot, { recursive: true, force: true });
      await rm(originParent, { recursive: true, force: true });
    }
  });

  it("concurrent status() calls on the same legacy container both succeed; file removed exactly once", async () => {
    const { paths, root, svc } = await setup();
    try {
      await registerLegacy(paths, root, "pr");
      // Two concurrent status() calls must not race: both should succeed, the
      // migrationMutex ensures the second becomes a no-op after the first removes the
      // legacy file, and the registry remains in a valid state.
      const [st1, st2] = await Promise.all([svc.status("legacy"), svc.status("legacy")]);
      expect(st1.sync?.mode).toBe("auto");
      expect(st2.sync?.mode).toBe("auto");
      // Legacy file must be gone — not left behind by a racing second caller.
      await expect(stat(join(root, ".okh", "okh.yaml"))).rejects.toThrow();
      const entry = findContainer(await loadRegistry(paths), "legacy");
      expect(entry!.sync.mode).toBe("auto");
    } finally {
      await rm(paths.home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("legacy git pr .okh migration preserves file on login failure", async () => {
    const origin = await makeOrigin({ "README.md": "# origin\n" });
    const originParent = dirname(origin);
    const root = await mkdtemp(join(tmpdir(), "okh-git-c-"));
    const { paths, root: setupRoot, gh } = await setup("bob");
    gh.currentLogin = async () => { throw new Error("not authenticated"); };
    const svc = new ContainerService(paths, new Git(testRun), gh as unknown as Gh);
    try {
      await new Git(testRun).clone(origin, root);
      await registerLegacyGit(paths, root, origin, "pr");
      // Status should not throw, but migration should not have completed
      await svc.status("hub").catch(() => undefined);
      // legacy file must still be there (login failed, migration incomplete)
      await expect(stat(join(root, ".okh", "okh.yaml"))).resolves.toBeDefined();
    } finally {
      await rm(paths.home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
      await rm(setupRoot, { recursive: true, force: true });
      await rm(originParent, { recursive: true, force: true });
    }
  });
});

describe("a module cannot be created at the container root", () => {
  it("rejects add module with path '.'", async () => {
    const { paths, root, svc } = await setup();
    try {
      const { saveRegistry } = await import("../src/registry/registry.js");
      await saveRegistry(paths, {
        version: 2,
        containers: [{ name: "h", backend: { type: "local", config: {} }, localPath: root, sync: { mode: "auto", config: {} }, addedAt: new Date().toISOString() }],
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
