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
  loginResult: string = "testuser";
  loginThrows: Error | undefined;
  prCalls: unknown[] = [];
  async currentLogin(): Promise<string> {
    if (this.loginThrows) throw this.loginThrows;
    return this.loginResult;
  }
  async findOpenPr(): Promise<string | undefined> { return undefined; }
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
    expect(entry.backend.type).toBe("git");
    expect(entry.backend.config["origin"]).toBe(origin);
    expect(entry.localPath).toBe(join(paths.containersDir, "my-hub"));
    expect(entry.sync.mode).toBe("auto");
  });

  it("registers a local folder in place", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    const out = await service.addContainer({ source: dir, name: "notes", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const entry = out.entry;
    expect(entry.backend.type).toBe("local");
    expect(entry.backend.config["origin"]).toBeUndefined();
    expect(entry.localPath).toBe(dir);
    expect(entry.sync.mode).toBe("auto");
  });

  it("labels an onedrive backend when requested", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    const out = await service.addContainer({ source: dir, name: "cloud", backend: "onedrive", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const entry = out.entry;
    expect(entry.backend.type).toBe("onedrive");
  });

  it("derives a name from the source when omitted", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    const out = await service.addContainer({ source: origin, create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const entry = out.entry;
    expect(entry.name).toMatch(/^[a-z0-9-]+$/);
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
    const out = await service.addModule({ container: "hub", path: "kb", type: "knowledge", description: "team kb", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const { moduleRoot } = out;
    expect((await stat(join(moduleRoot, "index.md"))).isFile()).toBe(true);
    expect(await moduleManifestExists(moduleRoot)).toBe(true);
    const m = await loadModuleManifest(moduleRoot);
    expect(m.type).toBe("knowledge");
    expect(m.description).toBe("team kb");
    expect(await readFile(join(moduleRoot, "index.md"), "utf8")).toContain("okf_version");
  });

  it("scaffolds a skills index", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    const out = await service.addModule({ container: "hub", path: "skills", type: "skills", description: "my skills", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const { moduleRoot } = out;
    expect((await stat(join(moduleRoot, "index.md"))).isFile()).toBe(true);
    expect(await readFile(join(moduleRoot, "index.md"), "utf8")).toContain("Skills module");
  });

  it("does not scaffold content for memory modules", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    const out = await service.addModule({ container: "hub", path: "mem", type: "memory", description: "notes", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    await expect(stat(join(out.moduleRoot, "index.md"))).rejects.toBeTruthy();
  });

  it("rejects a duplicate module path", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await service.addModule({ container: "hub", path: "kb", type: "knowledge", description: "team kb", create: true });
    await expect(service.addModule({ container: "hub", path: "kb", type: "skills", description: "x" })).rejects.toBeInstanceOf(OkhError);
  });

  it("rejects a module on an unknown container", async () => {
    const { service } = await setup();
    await expect(service.addModule({ container: "ghost", path: "kb", type: "knowledge", description: "kb" })).rejects.toBeInstanceOf(OkhError);
  });

  it("treats an existing knowledge index as already scaffolded", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await mkdir(join(dir, "kb"), { recursive: true });
    await writeFile(join(dir, "kb", "index.md"), "# Existing\n", "utf8");

    const out = await service.addModule({ container: "hub", path: "kb", type: "knowledge", description: "team kb", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    const { moduleRoot } = out;

    expect(moduleRoot).toBe(join(dir, "kb"));
    expect(await readFile(join(moduleRoot, "index.md"), "utf8")).toBe("# Existing\n");
    const m = await loadModuleManifest(moduleRoot);
    expect(m.type).toBe("knowledge");
    expect(m.description).toBe("team kb");
  });
  it("rejects a nested (multi-segment) module path", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await expect(
      service.addModule({ container: "hub", path: "nested/kb", type: "knowledge", description: "team kb", create: true }),
    ).rejects.toBeInstanceOf(OkhError);
  });
});

describe("setModuleDescription", () => {
  it("overwrites the manifest description and drops a legacy name", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await service.addModule({ container: "hub", path: "kb", type: "knowledge", description: "old", create: true });
    await service.setModuleDescription("hub", "kb", "  auth flows and token lifecycle  ");
    const m = await loadModuleManifest(join(dir, "kb"));
    expect(m.description).toBe("auth flows and token lifecycle");
    expect("name" in m).toBe(false);
  });

  it("rejects a blank description", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await service.addModule({ container: "hub", path: "kb", type: "knowledge", description: "old", create: true });
    await expect(service.setModuleDescription("hub", "kb", "   ")).rejects.toBeInstanceOf(OkhError);
  });

  it("rejects an unknown module", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await expect(service.setModuleDescription("hub", "ghost", "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
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

describe("addContainer sync descriptors", () => {
  it("resolves auto sync descriptor for git backend", async () => {
    const origin = await makeOrigin({ "README.md": "# origin\n" });
    const { service } = await setup();
    const out = await service.addContainer({ source: origin, name: "hub", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    expect(out.entry.sync.mode).toBe("auto");
    expect(out.entry.sync.config).toEqual({});
  });

  it("resolves auto sync descriptor for local backend", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    const out = await service.addContainer({ source: dir, name: "notes", create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    expect(out.entry.sync.mode).toBe("auto");
    expect(out.entry.sync.config).toEqual({});
  });

  it("resolves shared sync with explicit branch for git backend", async () => {
    const origin = await makeOrigin({ "README.md": "# origin\n" });
    const { service } = await setup();
    const out = await service.addContainer({
      source: origin, name: "team",
      sync: { mode: "shared", config: { branch: "my/team/branch" } },
      create: true,
    });
    if (out.kind !== "applied") throw new Error("expected applied");
    expect(out.entry.sync.mode).toBe("shared");
    expect(out.entry.sync.config["branch"]).toBe("my/team/branch");
  });

  it("resolves shared sync using login-derived branch when no branch given", async () => {
    const origin = await makeOrigin({ "README.md": "# origin\n" });
    const { service, gh } = await setup();
    gh.loginResult = "alice";
    const out = await service.addContainer({
      source: origin, name: "team",
      sync: { mode: "shared", config: {} },
      create: true,
    });
    if (out.kind !== "applied") throw new Error("expected applied");
    expect(out.entry.sync.mode).toBe("shared");
    expect(out.entry.sync.config["branch"]).toBe("user/alice/hub");
  });

  it("resolves shared sync with login-derived branch when config has no branch (structured input)", async () => {
    const origin = await makeOrigin({ "README.md": "# origin\n" });
    const { service, gh } = await setup();
    gh.loginResult = "testuser";
    const out = await service.addContainer({ source: origin, name: "team-git", sync: { mode: "shared", config: {} }, create: true });
    if (out.kind !== "applied") throw new Error("expected applied");
    expect(out.entry.sync.mode).toBe("shared");
    expect(out.entry.sync.config["branch"]).toBe("user/testuser/hub");
  });

  it("fails shared sync without branch when gh login is unavailable", async () => {
    const origin = await makeOrigin({ "README.md": "# origin\n" });
    const { service, gh } = await setup();
    gh.loginThrows = new Error("not authenticated");
    await expect(service.addContainer({
      source: origin, name: "team",
      sync: { mode: "shared", config: {} },
    })).rejects.toMatchObject({ code: "GH_ERROR" });
  });

  it("rejects shared sync on a local backend before side effects", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await expect(service.addContainer({
      source: dir, name: "team",
      sync: { mode: "shared", config: {} },
    })).rejects.toBeInstanceOf(OkhError);
    // folder must NOT have been created
    const stat2 = await stat(dir).catch(() => null);
    // dir already existed (makeTempDir), so we check nothing was registered
    const list = await service.list();
    expect(list).toHaveLength(0);
  });
});
