import { describe, it, expect, afterEach } from "vitest";
import { mkdir, rm, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { OkhError } from "../src/errors.js";
import { loadModuleManifest, moduleManifestExists } from "../src/modules/manifest.js";
import { makePaths, makeTempDir, makeOrigin, testRun } from "./helpers.js";

class FakeGh {
  prCalls: unknown[] = [];
  async createRepo(): Promise<string> { return "https://github.com/test/x"; }
  async createPr(opts: unknown): Promise<string> { this.prCalls.push(opts); return "https://github.com/test/x/pull/1"; }
}

class TestService extends ContainerService {
  exposeModuleRoot(containerRoot: string, modulePath: string): string {
    return this.moduleRoot(containerRoot, modulePath);
  }
}

const cleanups: string[] = [];
async function setup() {
  const home = await makeTempDir(); cleanups.push(home);
  const paths = makePaths(home);
  const gh = new FakeGh();
  const service = new ContainerService(paths, new Git(testRun), gh as unknown as Gh);
  return { paths, service, gh };
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("addContainer", () => {
  it("clones a git container into containersDir and registers it", async () => {
    const origin = await makeOrigin({ "README.md": "# origin\n" });
    const { service, paths } = await setup();
    const out = await service.addContainer({ source: origin, name: "my-hub", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const entry = out.entry;
    expect(entry.backend).toBe("git");
    expect(entry.origin).toBe(origin);
    expect(entry.localPath).toBe(join(paths.containersDir, "my-hub"));
    expect(entry.sync).toBe("auto");
  });

  it("registers a local folder in place", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    const out = await service.addContainer({ source: dir, name: "notes", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const entry = out.entry;
    expect(entry.backend).toBe("local");
    expect(entry.origin).toBeUndefined();
    expect(entry.localPath).toBe(dir);
    expect(entry.sync).toBe("auto");
  });

  it("labels an onedrive backend when requested", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    const out = await service.addContainer({ source: dir, name: "cloud", backend: "onedrive", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const entry = out.entry;
    expect(entry.backend).toBe("onedrive");
  });

  it("derives a name from the source when omitted", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    const out = await service.addContainer({ source: origin, create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const entry = out.entry;
    expect(entry.name).toMatch(/^[a-z0-9-]+$/);
  });

  it("honours an explicit sync mode in the registry entry", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    const out = await service.addContainer({ source: dir, name: "team", sync: "pr", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const entry = out.entry;
    expect(entry.sync).toBe("pr");
  });

  it("rejects a duplicate container name", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "dup", create: true });
    const dir2 = await makeTempDir(); cleanups.push(dir2);
    await expect(service.addContainer({ source: dir2, name: "dup" })).rejects.toBeInstanceOf(OkhError);
  });

  it("creates a non-existent local folder when create:true", async () => {
    const { service } = await setup();
    const dir = join(await makeTempDir(), "fresh"); cleanups.push(dir);
    const out = await service.addContainer({ source: dir, name: "x", create: true });
    expect(out.kind).toBe("applied");
    expect((await stat(dir)).isDirectory()).toBe(true);
  });
});

describe("addModule", () => {
  it("creates the folder, scaffolds a knowledge index, and writes a module manifest", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    const out = await service.addModule({ container: "hub", path: "kb", type: "knowledge", name: "KB", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const { moduleRoot } = out;
    expect((await stat(join(moduleRoot, "index.md"))).isFile()).toBe(true);
    expect(await moduleManifestExists(moduleRoot)).toBe(true);
    const m = await loadModuleManifest(moduleRoot);
    expect(m.type).toBe("knowledge");
    expect(m.name).toBe("KB");
    expect(await readFile(join(moduleRoot, "index.md"), "utf8")).toContain("okf_version");
  });

  it("does not scaffold content for non-knowledge modules", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    const out = await service.addModule({ container: "hub", path: "skills", type: "skills", name: "My Skills", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const { moduleRoot } = out;
    expect((await stat(moduleRoot)).isDirectory()).toBe(true);
    await expect(stat(join(moduleRoot, "index.md"))).rejects.toBeTruthy();
  });

  it("rejects a duplicate module path", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await service.addModule({ container: "hub", path: "kb", type: "knowledge", name: "KB", create: true });
    await expect(service.addModule({ container: "hub", path: "kb", type: "skills", name: "X" })).rejects.toBeInstanceOf(OkhError);
  });

  it("rejects a module on an unknown container", async () => {
    const { service } = await setup();
    await expect(service.addModule({ container: "ghost", path: "kb", type: "knowledge", name: "KB" })).rejects.toBeInstanceOf(OkhError);
  });

  it("treats an existing knowledge index as already scaffolded", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await mkdir(join(dir, "kb"), { recursive: true });
    await writeFile(join(dir, "kb", "index.md"), "# Existing\n", "utf8");

    const out = await service.addModule({ container: "hub", path: "kb", type: "knowledge", name: "KB", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const { moduleRoot } = out;

    expect(moduleRoot).toBe(join(dir, "kb"));
    expect(await readFile(join(moduleRoot, "index.md"), "utf8")).toBe("# Existing\n");
    const m = await loadModuleManifest(moduleRoot);
    expect(m.type).toBe("knowledge");
    expect(m.name).toBe("KB");
  });
});

describe("moduleRoot", () => {
  const itOnWindows = process.platform === "win32" ? it : it.skip;

  itOnWindows("rejects absolute paths on a different drive", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const service = new TestService(makePaths(home), new Git(testRun), new FakeGh() as unknown as Gh);

    expect(() => service.exposeModuleRoot("C:\\container", "D:\\escape")).toThrow(OkhError);
  });
});
