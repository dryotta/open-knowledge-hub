import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { OkhError } from "../src/errors.js";
import { makePaths, makeTempDir, makeOrigin, pushToOrigin, testRun, writeManifest } from "./helpers.js";

class FakeGh {
  prCalls: unknown[] = [];
  async createRepo(): Promise<string> { return "x"; }
  async createPr(opts: unknown): Promise<string> { this.prCalls.push(opts); return "https://github.com/test/x/pull/1"; }
}
const cleanups: string[] = [];
async function setup() {
  const home = await makeTempDir(); cleanups.push(home);
  const gh = new FakeGh();
  const service = new ContainerService(makePaths(home), new Git(testRun), gh as unknown as Gh);
  return { service, gh };
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
    await service.addContainer({ source: origin, name: "hub" }); // scaffolds .okh/okh.yaml (uncommitted)
    const [res] = await service.sync("hub");
    expect(res!.action).toBe("committed-pushed");
    expect(res!.pushed).toBe(true);
    const verify = await checkoutOrigin(origin);
    expect((await stat(join(verify, ".okh", "okh.yaml"))).isFile()).toBe(true);
  });

  it("fast-forwards remote changes on a subsequent sync", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    const entry = await service.addContainer({ source: origin, name: "hub" });
    await service.sync("hub"); // push the scaffolded manifest first
    await pushToOrigin(origin, "note.md", "hello");
    const [res] = await service.sync("hub");
    expect(res!.action).toBe("pulled");
    expect((await readFile(join(entry.localPath, "note.md"), "utf8"))).toBe("hello");
  });

  it("errors when local and remote have diverged", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    await service.addContainer({ source: origin, name: "hub" }); // local manifest uncommitted
    await pushToOrigin(origin, "remote.md", "x"); // remote advances
    await expect(service.sync("hub")).rejects.toMatchObject({ code: "GIT_ERROR" }); // commit local -> diverged -> ff-only fails
  });
});

describe("sync (pr)", () => {
  it("opens a PR via gh and returns the URL", async () => {
    const origin = await makeOrigin();
    const { service, gh } = await setup();
    await service.addContainer({ source: origin, name: "team", sync: "pr" });
    const [res] = await service.sync("team");
    expect(res!.action).toBe("pr-opened");
    expect(res!.prUrl).toContain("/pull/");
    expect(gh.prCalls).toHaveLength(1);
  });

  it("ignores unpushed commits on unrelated local branches", async () => {
    const origin = await makeOrigin({
      "README.md": "# origin\n",
      ".okh/okh.yaml": "name: team\nsync: pr\nmodules: []\n",
    });
    const { service, gh } = await setup();
    const entry = await service.addContainer({ source: origin, name: "team" });

    await testRun("git", ["checkout", "-b", "scratch"], { cwd: entry.localPath });
    await writeFile(join(entry.localPath, "scratch.md"), "x", "utf8");
    await testRun("git", ["add", "-A"], { cwd: entry.localPath });
    await testRun("git", ["commit", "-m", "scratch"], { cwd: entry.localPath });
    await testRun("git", ["checkout", "main"], { cwd: entry.localPath });

    const [res] = await service.sync("team");
    expect(res!.action).toBe("up-to-date");
    expect(gh.prCalls).toHaveLength(0);
  });
});

describe("sync (local backend)", () => {
  it("validates only, surfacing manifest issues", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "notes" });
    const [ok] = await service.sync("notes");
    expect(ok!.action).toBe("validated");
    expect(ok!.validation.ok).toBe(true);

    await writeManifest(dir, "name: notes\nmodules:\n  - path: gone\n    type: skills\n");
    const [bad] = await service.sync("notes");
    expect(bad!.validation.ok).toBe(false);
  });
});
