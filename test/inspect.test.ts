import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { makePaths, makeTempDir, makeOrigin, testRun, writeManifest } from "./helpers.js";

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

describe("status", () => {
  it("reports git status + modules for a git container", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    await service.addContainer({ source: origin, name: "hub" });
    await service.addModule({ container: "hub", path: "kb", type: "knowledge" });
    const st = await service.status("hub");
    expect(st.backend).toBe("git");
    expect(st.manifestValid).toBe(true);
    expect(st.git?.branch).toBe("main");
    expect(st.modules).toEqual([{ path: "kb", type: "knowledge", items: 0 }]);
  });

  it("omits git status for a local container", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "notes" });
    const st = await service.status("notes");
    expect(st.git).toBeUndefined();
    expect(st.sync).toBe("auto");
  });
});

describe("validate", () => {
  it("flags a missing module folder and a knowledge module without index.md", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub" });
    // Manifest references modules whose folders/files don't exist.
    await writeManifest(dir, "name: hub\nmodules:\n  - path: gone\n    type: skills\n  - path: kb\n    type: knowledge\n");
    const res = await service.validate("hub");
    expect(res.ok).toBe(false);
    expect(res.issues.join("\n")).toMatch(/gone.*missing/i);
    expect(res.issues.join("\n")).toMatch(/index\.md/i);
  });

  it("passes for a well-formed container", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub" });
    await service.addModule({ container: "hub", path: "kb", type: "knowledge" });
    expect((await service.validate("hub")).ok).toBe(true);
  });
});

describe("inspect", () => {
  it("lists containers with no args", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub" });
    const res = await service.inspect();
    expect(res.kind).toBe("containers");
    if (res.kind === "containers") expect(res.containers[0]!.name).toBe("hub");
  });

  it("returns container status with a container arg, and module items with both", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub" });
    await service.addModule({ container: "hub", path: "kb", type: "knowledge" });
    const c = await service.inspect("hub");
    expect(c.kind).toBe("container");
    const m = await service.inspect("hub", "kb");
    expect(m.kind).toBe("module");
    if (m.kind === "module") expect(m.module.type).toBe("knowledge");
  });

  it("throws NOT_FOUND for an unknown module", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub" });
    await expect(service.inspect("hub", "ghost")).rejects.toBeTruthy();
  });
});
