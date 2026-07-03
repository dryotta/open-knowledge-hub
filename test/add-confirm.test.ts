import { describe, it, expect, afterEach } from "vitest";
import { rm, stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { loadRegistry } from "../src/registry/registry.js";
import { loadContainerManifest, manifestExists } from "../src/container/manifest.js";
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
      expect(out.plan.actions).toContain("init-manifest");
    }
    await expect(stat(target)).rejects.toBeTruthy(); // folder NOT created
    expect((await loadRegistry(paths)).containers).toHaveLength(0); // NOT registered
  });

  it("creates the folder + manifest + registers with create:true", async () => {
    const { service, paths } = await setup();
    const target = join(paths.home, "new-hub");
    const out = await service.addContainer({ source: target, name: "new-hub", create: true });
    expect(out.kind).toBe("applied");
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(await manifestExists(target)).toBe(true);
    expect((await loadRegistry(paths)).containers[0]!.name).toBe("new-hub");
  });
});

describe("addModule preview/confirm", () => {
  it("previews (no side effects) without create", async () => {
    const { service, paths } = await setup();
    const dir = await makeTempDir(); cleanups.push(dir);
    await service.addContainer({ source: dir, name: "hub", create: true });
    const out = await service.addModule({ container: "hub", path: "kb", type: "knowledge" });
    expect(out.kind).toBe("plan");
    await expect(stat(join(dir, "kb"))).rejects.toBeTruthy(); // folder NOT created
  });

  it("creates folder + scaffold + manifest entry with create:true", async () => {
    const { service } = await setup();
    const dir = await makeTempDir(); cleanups.push(dir);
    await service.addContainer({ source: dir, name: "hub", create: true });
    const out = await service.addModule({ container: "hub", path: "kb", type: "knowledge", create: true });
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

  it("registers an existing hub (manifest present) in one call, no create needed", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    await mkdir(join(dir, ".okh"), { recursive: true });
    await writeFile(join(dir, ".okh", "okh.yaml"), "name: prebuilt\nsync: auto\nmodules: []\n", "utf8");
    const { service, paths } = await setup();
    const out = await service.addContainer({ source: dir, name: "prebuilt" });
    expect(out.kind).toBe("applied"); // actions empty => applied without create
    expect((await loadRegistry(paths)).containers[0]!.name).toBe("prebuilt");
  });

  it("previews an explicit sync override for an existing manifest without mutating it", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    await mkdir(join(dir, ".okh"), { recursive: true });
    await writeFile(join(dir, ".okh", "okh.yaml"), "name: sync-gated\nsync: auto\nmodules: []\n", "utf8");
    const { service } = await setup();

    const out = await service.addContainer({ source: dir, name: "sync-gated", sync: "pr" });

    expect(out.kind).toBe("plan");
    if (out.kind === "plan") expect(out.plan.actions).toContain("init-manifest");
    expect((await loadContainerManifest(dir)).sync).toBe("auto");
  });

  it("applies an explicit sync override for an existing manifest with create:true", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    await mkdir(join(dir, ".okh"), { recursive: true });
    await writeFile(join(dir, ".okh", "okh.yaml"), "name: sync-applied\nsync: auto\nmodules: []\n", "utf8");
    const { service } = await setup();

    const out = await service.addContainer({ source: dir, name: "sync-applied", sync: "pr", create: true });

    expect(out.kind).toBe("applied");
    expect((await loadContainerManifest(dir)).sync).toBe("pr");
  });

  it("registers an existing manifest with default sync in one call", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    await mkdir(join(dir, ".okh"), { recursive: true });
    await writeFile(join(dir, ".okh", "okh.yaml"), "name: sync-default\nsync: auto\nmodules: []\n", "utf8");
    const { service } = await setup();

    const out = await service.addContainer({ source: dir, name: "sync-default" });

    expect(out.kind).toBe("applied");
    expect((await loadContainerManifest(dir)).sync).toBe("auto");
  });
});
