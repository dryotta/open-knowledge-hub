import { describe, it, expect, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { saveModuleManifest } from "../src/modules/manifest.js";
import { makePaths, makeTempDir, makeOrigin, testRun } from "./helpers.js";

class FakeGh {
  async createRepo(): Promise<string> { return "x"; }
  async createPr(): Promise<string> { return "x"; }
}
const cleanups: string[] = [];
async function setup() {
  const home = await makeTempDir(); cleanups.push(home);
  const service = new ContainerService(makePaths(home), new Git(testRun), new FakeGh() as unknown as Gh);
  return { service };
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Create a module folder with a per-module manifest inside a container root. */
async function seedModule(containerRoot: string, path: string, type: string, name: string, description = ""): Promise<void> {
  const moduleRoot = join(containerRoot, path);
  await mkdir(moduleRoot, { recursive: true });
  await saveModuleManifest(moduleRoot, { type, name, description, config: {} });
}

describe("status", () => {
  it("reports git status + modules for a git container", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    await service.addContainer({ source: origin, name: "hub", create: true });
    const list = await service.list();
    const root = list[0]!.localPath;
    await seedModule(root, "kb", "knowledge", "KB", "team kb");
    const st = await service.status("hub");
    expect(st.backend).toBe("git");
    expect(st.manifestValid).toBe(true);
    expect(st.git?.branch).toBe("main");
    expect(st.modules).toEqual([{ path: "kb", type: "knowledge", name: "KB", description: "team kb", items: 0 }]);
  });

  it("omits git status for a local container", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "notes", create: true });
    const st = await service.status("notes");
    expect(st.git).toBeUndefined();
    expect(st.sync).toBe("auto");
  });
});

describe("validate", () => {
  it("flags a knowledge module without index.md", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await seedModule(dir, "kb", "knowledge", "KB");
    const res = await service.validate("hub");
    expect(res.ok).toBe(false);
    expect(res.issues.join("\n")).toMatch(/index\.md/i);
  });

  it("passes for a well-formed container", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await service.addModule({ container: "hub", path: "kb", type: "knowledge", name: "KB", create: true });
    // addModule scaffolds index.md; also need per-module manifest for discovery
    await saveModuleManifest(join(dir, "kb"), { type: "knowledge", name: "KB", description: "" });
    expect((await service.validate("hub")).ok).toBe(true);
  });
});

describe("inspect", () => {
  it("lists containers with no args", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    const res = await service.inspect();
    expect(res.kind).toBe("containers");
    if (res.kind === "containers") expect(res.containers[0]!.name).toBe("hub");
  });

  it("lists each container's modules in the top-level inspect", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await seedModule(dir, "kb", "knowledge", "KB", "team kb");
    const res = await service.inspect();
    expect(res.kind).toBe("containers");
    if (res.kind === "containers") {
      expect(res.containers[0]!.modules).toEqual([{ path: "kb", type: "knowledge", name: "KB" }]);
    }
  });

  it("returns container status with a container arg, and module items with both", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await seedModule(dir, "kb", "knowledge", "KB", "team kb");
    const c = await service.inspect("hub");
    expect(c.kind).toBe("container");
    const m = await service.inspect("hub", "kb");
    expect(m.kind).toBe("module");
    if (m.kind === "module") {
      expect(m.module.type).toBe("knowledge");
      expect(m.module.name).toBe("KB");
      expect(m.module.description).toBe("team kb");
    }
  });

  it("throws NOT_FOUND for an unknown module", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await expect(service.inspect("hub", "ghost")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
