import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ContainerService, type AddContainerInput } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { OkhError } from "../src/errors.js";
import { makePaths, makeTempDir, makeOrigin, pushToOrigin, testRun, writeManifest } from "./helpers.js";

class FakeGh {
  loginResult: string = "tester";
  findPrResult: string | undefined = undefined;
  createCalls: unknown[] = [];
  failNextCreatePr: Error | undefined;

  async currentLogin(): Promise<string> { return this.loginResult; }
  async findOpenPr(_opts: { cwd: string; base: string; head: string }): Promise<string | undefined> {
    return this.findPrResult;
  }
  async createRepo(): Promise<string> { return "x"; }
  async createPr(opts: unknown): Promise<string> {
    this.createCalls.push(opts);
    if (this.failNextCreatePr) {
      const err = this.failNextCreatePr;
      this.failNextCreatePr = undefined;
      throw err;
    }
    return "https://github.com/test/x/pull/1";
  }
}

async function registerGitContainer(paths: ReturnType<typeof makePaths>, root: string, sync: "auto" | "shared" = "shared"): Promise<void> {
  await mkdir(dirname(paths.registryFile), { recursive: true });
  await writeFile(paths.registryFile, `${JSON.stringify({
    version: 2,
    containers: [{
      name: "team",
      backend: { type: "git", config: { origin: "https://example.com/team.git" } },
      localPath: root,
      sync: { mode: sync, config: sync === "shared" ? { branch: "user/tester/hub" } : {} },
      addedAt: new Date().toISOString(),
    }],
  })}\n`, "utf8");
}
const cleanups: string[] = [];
async function setup() {
  const home = await makeTempDir(); cleanups.push(home);
  const gh = new FakeGh();
  const service = new ContainerService(makePaths(home), new Git(testRun), gh as unknown as Gh);
  return { service, gh };
}
async function addAppliedContainer(service: ContainerService, input: AddContainerInput) {
  const out = await service.addContainer({ ...input, create: true });
  if (out.kind !== "applied") throw new Error("expected applied");
  return out.entry;
}
/** Clone a bare origin into a fresh dir and return its checkout path. */
async function checkoutOrigin(bare: string): Promise<string> {
  const dest = await makeTempDir("okh-verify-"); cleanups.push(dest);
  await testRun("git", ["clone", bare, dest]);
  return dest;
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("sync (auto)", () => {
  it("commits and pushes local changes to the origin", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    await addAppliedContainer(service, { source: origin, name: "hub" });
    // Write a file to make the working tree dirty
    const list = await service.list();
    await writeFile(join(list[0]!.localPath, "note.md"), "hello", "utf8");
    const [res] = await service.sync("hub");
    expect(res!.outcome).toBe("synced");
    expect(res!.pushed).toBe(true);
    const verify = await checkoutOrigin(origin);
    expect((await stat(join(verify, "note.md"))).isFile()).toBe(true);
  });

  it("fast-forwards remote changes on a subsequent sync", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    const entry = await addAppliedContainer(service, { source: origin, name: "hub" });
    // Make a local change and sync it first
    await writeFile(join(entry.localPath, "local.md"), "x", "utf8");
    await service.sync("hub");
    await pushToOrigin(origin, "note.md", "hello");
    const [res] = await service.sync("hub");
    expect(res!.outcome).toBe("synced");
    expect((await readFile(join(entry.localPath, "note.md"), "utf8"))).toBe("hello");
  });

  it("errors when local and remote have diverged", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    const entry = await addAppliedContainer(service, { source: origin, name: "hub" });
    // Create a local change to commit
    await writeFile(join(entry.localPath, "local.md"), "x", "utf8");
    await pushToOrigin(origin, "remote.md", "x"); // remote advances
    await expect(service.sync("hub")).rejects.toMatchObject({ code: "GIT_ERROR" }); // commit local -> diverged -> ff-only fails
  });

  it("continues syncing other containers when one container fails during sync-all", async () => {
    const divergedOrigin = await makeOrigin();
    const cleanOrigin = await makeOrigin();
    const { service } = await setup();
    const divergedEntry = await addAppliedContainer(service, { source: divergedOrigin, name: "diverged" });
    const cleanEntry = await addAppliedContainer(service, { source: cleanOrigin, name: "clean" });
    // Make local changes so there's something to commit
    await writeFile(join(divergedEntry.localPath, "local.md"), "x", "utf8");
    await writeFile(join(cleanEntry.localPath, "local.md"), "x", "utf8");
    await pushToOrigin(divergedOrigin, "remote.md", "x"); // remote advances before local commit

    const results = await service.sync();

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.name === "diverged")).toMatchObject({
      outcome: "error",
      error: expect.stringContaining("sync pull failed"),
      validation: { ok: true, issues: [] },
    });
    expect(results.find((r) => r.name === "clean")).toMatchObject({
      outcome: "synced",
      pushed: true,
    });
  });

  it("rejects an action without a named container", async () => {
    const { service } = await setup();
    await expect(service.sync(undefined, undefined, "publish-pr")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("sync (shared)", () => {
  it("commits local changes and pushes to the shared branch", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    const entry = await addAppliedContainer(service, {
      source: origin, name: "team",
      sync: { mode: "shared", config: { branch: "user/tester/hub" } },
    });
    await writeFile(join(entry.localPath, "note.md"), "x", "utf8");
    const [res] = await service.sync("team");
    expect(res!.outcome).toBe("synced");
    expect(res!.branch).toBe("user/tester/hub");
    expect(res!.pushed).toBe(true);
  });

  it("publishes a PR when action=publish-pr", async () => {
    const origin = await makeOrigin();
    const { service, gh } = await setup();
    const entry = await addAppliedContainer(service, {
      source: origin, name: "team",
      sync: { mode: "shared", config: { branch: "user/tester/hub" } },
    });
    await writeFile(join(entry.localPath, "note.md"), "x", "utf8");
    const [res] = await service.sync("team", undefined, "publish-pr");
    expect(res!.outcome).toBe("published");
    expect(res!.prUrl).toContain("/pull/");
    expect(gh.createCalls).toHaveLength(1);
  });

  it("finds an existing PR instead of opening a new one", async () => {
    const origin = await makeOrigin();
    const { service, gh } = await setup();
    gh.findPrResult = "https://github.com/test/x/pull/99";
    const entry = await addAppliedContainer(service, {
      source: origin, name: "team",
      sync: { mode: "shared", config: { branch: "user/tester/hub" } },
    });
    await writeFile(join(entry.localPath, "note.md"), "x", "utf8");
    const [res] = await service.sync("team", undefined, "publish-pr");
    expect(res!.outcome).toBe("published");
    expect(res!.prUrl).toBe("https://github.com/test/x/pull/99");
    expect(gh.createCalls).toHaveLength(0);
  });

  it("returns up-to-date when no changes and no remote work (after branch established)", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    await addAppliedContainer(service, {
      source: origin, name: "team",
      sync: { mode: "shared", config: { branch: "user/tester/hub" } },
    });
    // First sync establishes the shared branch (isNew → "synced").
    await service.sync("team");
    // Second sync: branch exists, no local changes, no remote work → up-to-date.
    const [res] = await service.sync("team");
    expect(res!.outcome).toBe("up-to-date");
  });
});

describe("sync (local backend)", () => {
  it("validates only, surfacing manifest issues", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await addAppliedContainer(service, { source: dir, name: "notes" });
    const [ok] = await service.sync("notes");
    expect(ok!.outcome).toBe("validated");
    expect(ok!.validation.ok).toBe(true);

    // Create a knowledge module manifest without an index.md → validation fails
    const { saveModuleManifest } = await import("../src/modules/manifest.js");
    const { mkdir: mkdirFs } = await import("node:fs/promises");
    await mkdirFs(join(dir, "kb"), { recursive: true });
    await saveModuleManifest(join(dir, "kb"), { type: "knowledge", name: "KB", description: "" });
    const [bad] = await service.sync("notes");
    expect(bad!.validation.ok).toBe(false);
  });
});
