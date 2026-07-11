import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ContainerService, type AddContainerInput } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { OkhError } from "../src/errors.js";
import { makePaths, makeTempDir, makeOrigin, pushToOrigin, testRun, writeManifest } from "./helpers.js";

class FakeGh {
  prCalls: unknown[] = [];
  failNextCreatePr: Error | undefined;
  async createRepo(): Promise<string> { return "x"; }
  async createPr(opts: unknown): Promise<string> {
    this.prCalls.push(opts);
    if (this.failNextCreatePr) {
      const err = this.failNextCreatePr;
      this.failNextCreatePr = undefined;
      throw err;
    }
    return "https://github.com/test/x/pull/1";
  }
}

class CheckoutFailingGit {
  async currentBranch(): Promise<string> { return "main"; }
  async isDirty(): Promise<boolean> { return true; }
  async hasCurrentBranchUnpushedCommits(): Promise<boolean> { return false; }
  async createBranch(): Promise<void> {}
  async stageAll(): Promise<void> {}
  async hasStagedChanges(): Promise<boolean> { return true; }
  async commit(): Promise<void> {}
  async defaultRemote(): Promise<string> { return "origin"; }
  async push(): Promise<void> {}
  async resetSoft(): Promise<void> {}
  async checkout(): Promise<void> { throw new OkhError("GIT_ERROR", "checkout failed"); }
}

class ResetFailingGit {
  checkoutCalls = 0;
  async currentBranch(): Promise<string> { return "main"; }
  async isDirty(): Promise<boolean> { return true; }
  async hasCurrentBranchUnpushedCommits(): Promise<boolean> { return false; }
  async createBranch(): Promise<void> {}
  async stageAll(): Promise<void> {}
  async hasStagedChanges(): Promise<boolean> { return true; }
  async commit(): Promise<void> {}
  async defaultRemote(): Promise<string> { return "origin"; }
  async push(): Promise<void> {}
  async resetSoft(): Promise<void> { throw new OkhError("GIT_ERROR", "reset failed"); }
  async checkout(): Promise<void> { this.checkoutCalls += 1; }
}

class StaleSyncBranchGit {
  async currentBranch(): Promise<string> { return "okh/team/sync-123"; }
  async isDirty(): Promise<boolean> { return true; }
  async hasCurrentBranchUnpushedCommits(): Promise<boolean> { return false; }
  async createBranch(): Promise<void> {}
  async stageAll(): Promise<void> {}
  async hasStagedChanges(): Promise<boolean> { return true; }
  async commit(): Promise<void> {}
  async defaultRemote(): Promise<string> { return "origin"; }
  async push(): Promise<void> {}
  async resetSoft(): Promise<void> {}
  async checkout(): Promise<void> {}
}

class FailingCreatePrGh {
  async createRepo(): Promise<string> { return "x"; }
  async createPr(): Promise<string> { throw new OkhError("GH_ERROR", "create PR failed"); }
}

async function registerGitContainer(paths: ReturnType<typeof makePaths>, root: string, sync: "auto" | "shared" = "shared"): Promise<void> {
  await mkdir(dirname(paths.registryFile), { recursive: true });
  await writeFile(paths.registryFile, `${JSON.stringify({
    version: 2,
    containers: [{
      name: "team",
      backend: { type: "git", config: { origin: "https://example.com/team.git" } },
      localPath: root,
      sync: { mode: sync, config: sync === "shared" ? { branch: "user/test/hub" } : {} },
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
    expect(res!.action).toBe("committed-pushed");
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
    expect(res!.action).toBe("pulled");
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
      action: "error",
      error: expect.stringContaining("sync pull failed"),
      validation: { ok: true, issues: [] },
    });
    expect(results.find((r) => r.name === "clean")).toMatchObject({
      action: "committed-pushed",
      pushed: true,
    });
  });
});

describe("sync (pr)", () => {
  it("opens a PR via gh and returns the URL", async () => {
    const origin = await makeOrigin();
    const { service, gh } = await setup();
    const entry = await addAppliedContainer(service, { source: origin, name: "team", sync: "pr" });
    await writeFile(join(entry.localPath, "note.md"), "x", "utf8");
    const [res] = await service.sync("team");
    expect(res!.action).toBe("pr-opened");
    expect(res!.prUrl).toContain("/pull/");
    expect(gh.prCalls).toHaveLength(1);
  });

  it("ignores unpushed commits on unrelated local branches", async () => {
    const origin = await makeOrigin();
    const { service, gh } = await setup();
    const entry = await addAppliedContainer(service, { source: origin, name: "team", sync: "pr" });

    await testRun("git", ["checkout", "-b", "scratch"], { cwd: entry.localPath });
    await writeFile(join(entry.localPath, "scratch.md"), "x", "utf8");
    await testRun("git", ["add", "-A"], { cwd: entry.localPath });
    await testRun("git", ["commit", "-m", "scratch"], { cwd: entry.localPath });
    await testRun("git", ["checkout", "main"], { cwd: entry.localPath });

    const [res] = await service.sync("team");
    expect(res!.action).toBe("up-to-date");
    expect(gh.prCalls).toHaveLength(0);
  });

  it("opens PRs from fresh sync branches and returns to the base branch after each sync", async () => {
    const origin = await makeOrigin();
    const { service, gh } = await setup();
    const entry = await addAppliedContainer(service, { source: origin, name: "team", sync: "pr" });

    await writeFile(join(entry.localPath, "note-1.md"), "first", "utf8");
    const [first] = await service.sync("team");

    expect(first).toMatchObject({ action: "pr-opened", pushed: true });
    expect((await service.status("team")).git?.branch).toBe("main");

    await writeFile(join(entry.localPath, "note-2.md"), "second", "utf8");
    const [second] = await service.sync("team");

    expect(second).toMatchObject({ action: "pr-opened", pushed: true });
    expect((await service.status("team")).git?.branch).toBe("main");
    expect(gh.prCalls).toHaveLength(2);
    expect(gh.prCalls).toEqual([
      expect.objectContaining({ base: "main" }),
      expect.objectContaining({ base: "main" }),
    ]);
  });

  it("restores pending changes to the base branch so a failed PR create can be retried", async () => {
    const origin = await makeOrigin();
    const { service, gh } = await setup();
    const entry = await addAppliedContainer(service, { source: origin, name: "team", sync: "pr" });
    gh.failNextCreatePr = new OkhError("GH_ERROR", "create PR failed");
    await writeFile(join(entry.localPath, "note.md"), "pending", "utf8");

    await expect(service.sync("team")).rejects.toMatchObject({ code: "GH_ERROR" });
    expect((await service.status("team")).git).toMatchObject({ branch: "main", dirty: true });

    const [retry] = await service.sync("team");

    expect(retry).toMatchObject({ action: "pr-opened", pushed: true });
    expect((await service.status("team")).git?.branch).toBe("main");
    expect(gh.prCalls).toHaveLength(2);
  });

  it("preserves the primary PR error when returning to base also fails", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const root = await makeTempDir(); cleanups.push(root);
    const paths = makePaths(home);
    await writeManifest(root, "name: team\nsync: pr\nmodules: []\n");
    await registerGitContainer(paths, root);
    const service = new ContainerService(
      paths,
      new CheckoutFailingGit() as unknown as Git,
      new FailingCreatePrGh() as unknown as Gh,
    );

    await expect(service.sync("team")).rejects.toMatchObject({ code: "GH_ERROR" });
  });

  it("still tries to return to base when restoring pending changes fails", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const root = await makeTempDir(); cleanups.push(root);
    const paths = makePaths(home);
    await writeManifest(root, "name: team\nsync: pr\nmodules: []\n");
    await registerGitContainer(paths, root);
    const git = new ResetFailingGit();
    const service = new ContainerService(
      paths,
      git as unknown as Git,
      new FailingCreatePrGh() as unknown as Gh,
    );

    await expect(service.sync("team")).rejects.toMatchObject({
      code: "GH_ERROR",
      message: expect.stringContaining("restore pending changes"),
    });
    expect(git.checkoutCalls).toBe(1);
  });

  it("reports the PR URL when opening the PR succeeds but returning to base fails", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const root = await makeTempDir(); cleanups.push(root);
    const paths = makePaths(home);
    await writeManifest(root, "name: team\nsync: pr\nmodules: []\n");
    await registerGitContainer(paths, root);
    const service = new ContainerService(
      paths,
      new CheckoutFailingGit() as unknown as Git,
      new FakeGh() as unknown as Gh,
    );

    await expect(service.sync("team")).rejects.toMatchObject({
      code: "GIT_ERROR",
      message: expect.stringContaining("https://github.com/test/x/pull/1"),
      hint: expect.stringContaining("manually check out"),
    });
  });

  it("refuses to treat a generated sync branch as the PR base", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const root = await makeTempDir(); cleanups.push(root);
    const paths = makePaths(home);
    await writeManifest(root, "name: team\nsync: pr\nmodules: []\n");
    await registerGitContainer(paths, root);
    const gh = new FakeGh();
    const service = new ContainerService(
      paths,
      new StaleSyncBranchGit() as unknown as Git,
      gh as unknown as Gh,
    );

    await expect(service.sync("team")).rejects.toMatchObject({
      code: "GIT_ERROR",
      message: expect.stringContaining("generated sync branch"),
    });
    expect(gh.prCalls).toHaveLength(0);
  });
});

describe("sync (local backend)", () => {
  it("validates only, surfacing manifest issues", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await addAppliedContainer(service, { source: dir, name: "notes" });
    const [ok] = await service.sync("notes");
    expect(ok!.action).toBe("validated");
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
