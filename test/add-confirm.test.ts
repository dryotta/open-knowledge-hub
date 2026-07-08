import { describe, it, expect, afterEach } from "vitest";
import { rm, stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { loadRegistry } from "../src/registry/registry.js";
import { moduleManifestExists } from "../src/modules/manifest.js";
import { makePaths, makeTempDir, makeOrigin, testRun } from "./helpers.js";

class FakeGh {
  async createRepo(): Promise<string> { return "x"; }
  async createPr(): Promise<string> { return "x"; }
}

const cleanups: string[] = [];
async function setup() {
  const home = await makeTempDir(); cleanups.push(home);
  const paths = makePaths(home);
  const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
  return { paths, service };
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("addContainer preview/confirm", () => {
  it("previews (no side effects) for a non-existent folder without create", async () => {
    const { service, paths } = await setup();
    const target = join(paths.home, "new-hub"); // does not exist
    const out = await service.addContainer({ source: target, name: "new-hub" });
    expect(out.kind).toBe("plan");
    if (out.kind === "plan") {
      expect(out.plan.actions).toContain("create-folder");
      expect(out.plan.actions).not.toContain("init-manifest");
    }
    await expect(stat(target)).rejects.toBeTruthy(); // folder NOT created
    expect((await loadRegistry(paths)).containers).toHaveLength(0); // NOT registered
  });

  it("creates the folder + registers with create:true", async () => {
    const { service, paths } = await setup();
    const target = join(paths.home, "new-hub");
    const out = await service.addContainer({ source: target, name: "new-hub", create: true });
    expect(out.kind).toBe("applied");
    expect((await stat(target)).isDirectory()).toBe(true);
    expect((await loadRegistry(paths)).containers[0]!.name).toBe("new-hub");
  });
});

describe("addModule preview/confirm", () => {
  it("previews (no side effects) without create", async () => {
    const { service, paths } = await setup();
    const dir = await makeTempDir(); cleanups.push(dir);
    await service.addContainer({ source: dir, name: "hub", create: true });
    const out = await service.addModule({ container: "hub", path: "kb", type: "knowledge", name: "KB" });
    expect(out.kind).toBe("plan");
    await expect(stat(join(dir, "kb"))).rejects.toBeTruthy(); // folder NOT created
  });

  it("previews an existing non-scaffold module folder without creating a manifest", async () => {
    const { service } = await setup();
    const dir = await makeTempDir(); cleanups.push(dir);
    await service.addContainer({ source: dir, name: "hub", create: true });
    await mkdir(join(dir, "myskills"));

    const out = await service.addModule({ container: "hub", path: "myskills", type: "skills", name: "My Skills" });

    expect(out.kind).toBe("plan");
    expect(await moduleManifestExists(join(dir, "myskills"))).toBe(false);
  });

  it("creates folder + scaffold + module manifest with create:true", async () => {
    const { service } = await setup();
    const dir = await makeTempDir(); cleanups.push(dir);
    await service.addContainer({ source: dir, name: "hub", create: true });
    const out = await service.addModule({ container: "hub", path: "kb", type: "knowledge", name: "KB", create: true });
    expect(out.kind).toBe("applied");
    if (out.kind === "applied") {
      expect((await stat(join(out.moduleRoot, "index.md"))).isFile()).toBe(true);
    }
  });
});

describe("addContainer git + existing-hub", () => {
  it("previews a git url without cloning", async () => {
    const origin = await makeOrigin();
    const { service, paths } = await setup();
    const out = await service.addContainer({ source: origin, name: "gh" });
    expect(out.kind).toBe("plan");
    if (out.kind === "plan") expect(out.plan.actions).toEqual(["clone"]);
    await expect(stat(join(paths.containersDir, "gh"))).rejects.toBeTruthy(); // nothing cloned
    expect((await loadRegistry(paths)).containers).toHaveLength(0);
  });

  it("clones + registers a git url with create:true", async () => {
    const origin = await makeOrigin();
    const { service, paths } = await setup();
    const out = await service.addContainer({ source: origin, name: "gh", create: true });
    expect(out.kind).toBe("applied");
    if (out.kind === "applied") expect(out.entry.backend).toBe("git");
    expect((await loadRegistry(paths)).containers[0]!.name).toBe("gh");
  });

  it("registers an existing hub (folder present) in one call with create:true", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    await mkdir(join(dir, ".okh"), { recursive: true });
    await writeFile(join(dir, ".okh", "okh.yaml"), "name: prebuilt\nsync: auto\nmodules: []\n", "utf8");
    const { service, paths } = await setup();
    const out = await service.addContainer({ source: dir, name: "prebuilt", create: true });
    expect(out.kind).toBe("applied");
    expect((await loadRegistry(paths)).containers[0]!.name).toBe("prebuilt");
  });

  it("previews an existing folder without create (actions empty)", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    await mkdir(join(dir, ".okh"), { recursive: true });
    await writeFile(join(dir, ".okh", "okh.yaml"), "name: sync-gated\nsync: auto\nmodules: []\n", "utf8");
    const { service } = await setup();

    const out = await service.addContainer({ source: dir, name: "sync-gated", sync: "pr" });

    expect(out.kind).toBe("plan");
    if (out.kind === "plan") expect(out.plan.actions).toEqual([]);
  });

  it("applies an explicit sync override via the registry entry with create:true", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    await mkdir(join(dir, ".okh"), { recursive: true });
    await writeFile(join(dir, ".okh", "okh.yaml"), "name: sync-applied\nsync: auto\nmodules: []\n", "utf8");
    const { service, paths } = await setup();

    const out = await service.addContainer({ source: dir, name: "sync-applied", sync: "pr", create: true });

    expect(out.kind).toBe("applied");
    if (out.kind === "applied") expect(out.entry.sync).toBe("pr");
    expect((await loadRegistry(paths)).containers[0]!.sync).toBe("pr");
  });

  it("registers an existing folder with migrated sync in one call", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    await mkdir(join(dir, ".okh"), { recursive: true });
    await writeFile(join(dir, ".okh", "okh.yaml"), "name: sync-default\nsync: auto\nmodules: []\n", "utf8");
    const { service, paths } = await setup();

    const out = await service.addContainer({ source: dir, name: "sync-default", create: true });

    expect(out.kind).toBe("applied");
    if (out.kind === "applied") expect(out.entry.sync).toBe("auto");
  });
});
