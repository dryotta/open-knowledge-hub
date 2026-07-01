import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PackService } from "../src/packs/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { OkhError } from "../src/errors.js";
import { makePaths, makeTempDir, makeOrigin, pushToOrigin, testRun } from "./helpers.js";

/** A Gh double that records calls and avoids the network. */
class FakeGh {
  createRepoCalls: unknown[] = [];
  prCalls: unknown[] = [];
  async createRepo(opts: unknown): Promise<string> {
    this.createRepoCalls.push(opts);
    return "https://github.com/test/new-pack";
  }
  async createPr(opts: unknown): Promise<string> {
    this.prCalls.push(opts);
    return "https://github.com/test/repo/pull/1";
  }
}

const cleanups: string[] = [];
async function setup() {
  const home = await makeTempDir();
  cleanups.push(home);
  const paths = makePaths(home);
  const gh = new FakeGh();
  const service = new PackService(paths, new Git(testRun), gh as unknown as Gh);
  return { paths, service, gh };
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("install lifecycle", () => {
  it("adds and installs a full-repo (root) pack", async () => {
    const origin = await makeOrigin({ "index.md": "# pack\n" });
    const { service, paths } = await setup();
    await service.add({ slug: "alpha", repoUrl: origin, subpath: "." });
    const entry = await service.install("alpha");

    expect(entry.state).toBe("installed");
    expect(entry.subpath).toBeUndefined();
    expect(entry.localPath).toBe(join(paths.packsDir, "alpha"));
    expect(await readFile(join(entry.localPath!, "index.md"), "utf8")).toContain("# pack");
  });

  it("defaults to the 'knowledge' subfolder when no subpath is given", async () => {
    const origin = await makeOrigin({ "knowledge/index.md": "# pack\n" });
    const { service, paths } = await setup();
    const entry = await service.install("alpha", { slug: "alpha", repoUrl: origin });

    expect(entry.subpath).toBe("knowledge");
    expect(entry.localPath).toBe(join(paths.packsDir, "alpha", "knowledge"));
    expect(await readFile(join(entry.localPath!, "index.md"), "utf8")).toContain("# pack");
  });

  it("installs a subfolder pack and rejects a bad subpath", async () => {
    const origin = await makeOrigin({ "knowledge/billing/index.md": "# billing\n" });
    const { service, paths } = await setup();

    const entry = await service.install("billing", {
      slug: "billing",
      repoUrl: origin,
      subpath: "knowledge/billing",
    });
    expect(entry.localPath).toBe(join(paths.packsDir, "billing", "knowledge/billing"));

    await expect(
      service.install("bad", { slug: "bad", repoUrl: origin, subpath: "does/not/exist" }),
    ).rejects.toBeInstanceOf(OkhError);
    // failed install cleaned up the clone dir
    await expect(stat(join(paths.packsDir, "bad"))).rejects.toBeTruthy();
  });

  it("refuses to install twice", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    await service.install("alpha", { slug: "alpha", repoUrl: origin, subpath: "." });
    await expect(service.install("alpha")).rejects.toMatchObject({ code: "ALREADY_INSTALLED" });
  });

  it("reports status of an installed pack", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    await service.install("alpha", { slug: "alpha", repoUrl: origin, subpath: "." });
    const status = await service.status("alpha");
    expect(status.installed).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.dirty).toBe(false);
    expect(status.hasUnpushedCommits).toBe(false);
  });
});

describe("pull with auto-stash", () => {
  it("preserves local uncommitted changes across a pull", async () => {
    const origin = await makeOrigin({ "index.md": "v1\n" });
    const { service } = await setup();
    const entry = await service.install("alpha", { slug: "alpha", repoUrl: origin, subpath: "." });

    // local uncommitted edit
    await writeFile(join(entry.localPath!, "local.md"), "local work\n", "utf8");
    // origin advances
    await pushToOrigin(origin, "remote.md", "from remote\n");

    const { stashed } = await service.pull("alpha");
    expect(stashed).toBe(true);
    expect(await readFile(join(entry.localPath!, "remote.md"), "utf8")).toContain("from remote");
    expect(await readFile(join(entry.localPath!, "local.md"), "utf8")).toContain("local work");
  });
});

describe("PR write flow", () => {
  it("begins a change, commits, and opens a PR", async () => {
    const origin = await makeOrigin({ "index.md": "# pack\n" });
    const { service, gh } = await setup();
    const entry = await service.install("alpha", { slug: "alpha", repoUrl: origin, subpath: "." });

    const { branch } = await service.beginChange("alpha", "Add Concept X!");
    expect(branch).toBe("okh/alpha/add-concept-x");

    await writeFile(join(entry.localPath!, "concept.md"), "# concept\n", "utf8");
    await service.commit("alpha", "docs: add concept");

    const { prUrl } = await service.openPr("alpha", "Add concept", "body");
    expect(prUrl).toContain("/pull/1");
    expect(gh.prCalls).toHaveLength(1);
  });

  it("refuses to begin a change on a dirty tree", async () => {
    const origin = await makeOrigin({ "index.md": "# pack\n" });
    const { service } = await setup();
    const entry = await service.install("alpha", { slug: "alpha", repoUrl: origin, subpath: "." });
    await writeFile(join(entry.localPath!, "dirty.md"), "x\n", "utf8");
    await expect(service.beginChange("alpha", "topic")).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
  });

  it("refuses to commit with no changes", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    await service.install("alpha", { slug: "alpha", repoUrl: origin, subpath: "." });
    await service.beginChange("alpha", "topic");
    await expect(service.commit("alpha", "empty")).rejects.toBeInstanceOf(OkhError);
  });
});

describe("uninstall", () => {
  it("blocks when there are unpushed commits, unless forced", async () => {
    const origin = await makeOrigin({ "index.md": "# pack\n" });
    const { service, paths } = await setup();
    const entry = await service.install("alpha", { slug: "alpha", repoUrl: origin, subpath: "." });
    await service.beginChange("alpha", "wip");
    await writeFile(join(entry.localPath!, "wip.md"), "wip\n", "utf8");
    await service.commit("alpha", "wip");

    await expect(service.uninstall("alpha")).rejects.toMatchObject({ code: "UNPUSHED_COMMITS" });

    await service.uninstall("alpha", { force: true });
    await expect(stat(join(paths.packsDir, "alpha"))).rejects.toBeTruthy();
    // entry reverts to registered by default
    const list = await service.list();
    expect(list.find((p) => p.slug === "alpha")?.state).toBe("registered");
  });

  it("purges the catalog entry when requested", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    await service.install("alpha", { slug: "alpha", repoUrl: origin, subpath: "." });
    await service.uninstall("alpha", { purge: true });
    expect(await service.list()).toHaveLength(0);
  });
});

describe("input safety", () => {
  it("rejects a traversal subpath on create", async () => {
    const { service } = await setup();
    await expect(service.create({ slug: "evil", subpath: "../../escape" })).rejects.toBeInstanceOf(OkhError);
  });

  it("rejects a remote-helper repoUrl on install", async () => {
    const { service } = await setup();
    await expect(
      service.install("evil", { slug: "evil", repoUrl: "ext::sh -c id" }),
    ).rejects.toBeInstanceOf(OkhError);
  });
});

describe("concurrency", () => {
  it("serializes parallel installs without losing entries", async () => {
    const [o1, o2, o3] = await Promise.all([makeOrigin(), makeOrigin(), makeOrigin()]);
    const { service } = await setup();
    await Promise.all([
      service.install("a", { slug: "a", repoUrl: o1, subpath: "." }),
      service.install("b", { slug: "b", repoUrl: o2, subpath: "." }),
      service.install("c", { slug: "c", repoUrl: o3, subpath: "." }),
    ]);
    const slugs = (await service.list()).map((p) => p.slug).sort();
    expect(slugs).toEqual(["a", "b", "c"]);
  });
});

describe("create and publish", () => {
  it("scaffolds a new pack under 'knowledge/' by default and publishes it", async () => {
    const { service, gh, paths } = await setup();
    const entry = await service.create({ slug: "new-pack", title: "New Pack" });
    expect(entry.state).toBe("installed");
    expect(entry.subpath).toBe("knowledge");
    expect(entry.localPath).toBe(join(paths.packsDir, "new-pack", "knowledge"));
    const idx = await readFile(join(paths.packsDir, "new-pack", "knowledge", "index.md"), "utf8");
    expect(idx).toContain("New Pack");
    expect(idx).toContain("okf_version");

    const { repoUrl } = await service.publish({ slug: "new-pack", repoName: "new-pack", visibility: "private" });
    expect(repoUrl).toContain("github.com/test/new-pack");
    expect(gh.createRepoCalls).toHaveLength(1);
    expect((await service.list())[0]!.repoUrl).toBe(repoUrl);
  });

  it("scaffolds at the repo root when subpath is '.'", async () => {
    const { service, paths } = await setup();
    const entry = await service.create({ slug: "root-pack", subpath: "." });
    expect(entry.subpath).toBeUndefined();
    expect(entry.localPath).toBe(join(paths.packsDir, "root-pack"));
    await expect(stat(join(entry.localPath!, "index.md"))).resolves.toBeTruthy();
  });

  it("scaffolds a subfolder pack", async () => {
    const { service, paths } = await setup();
    const entry = await service.create({ slug: "sub", subpath: "knowledge/sub" });
    expect(entry.localPath).toBe(join(paths.packsDir, "sub", "knowledge/sub"));
    await expect(stat(join(entry.localPath!, "index.md"))).resolves.toBeTruthy();
  });
});
