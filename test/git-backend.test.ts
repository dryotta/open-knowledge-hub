import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { OkhError } from "../src/errors.js";
import { GitBackend } from "../src/sync/gitBackend.js";
import type { ContainerEntry } from "../src/registry/schema.js";
import { makeOrigin, pushToOrigin, testRun, makeTempDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// Fake Gh
// ---------------------------------------------------------------------------

class FakeGh {
  loginResult: string | Error = "testuser";
  findPrResult: string | Error | undefined = undefined;
  createPrResult: string | Error = "https://github.com/test/repo/pull/1";

  loginCalls = 0;
  findCalls: Array<{ cwd: string; base: string; head: string }> = [];
  createCalls: Array<{ cwd: string; base?: string; head?: string; title: string; body: string }> = [];

  async currentLogin(): Promise<string> {
    this.loginCalls++;
    if (this.loginResult instanceof Error) throw this.loginResult;
    return this.loginResult;
  }

  async findOpenPr(opts: { cwd: string; base: string; head: string }): Promise<string | undefined> {
    this.findCalls.push(opts);
    if (this.findPrResult instanceof Error) throw this.findPrResult;
    return this.findPrResult;
  }

  async createPr(opts: { cwd: string; base?: string; head?: string; title: string; body: string }): Promise<string> {
    this.createCalls.push(opts);
    if (this.createPrResult instanceof Error) throw this.createPrResult;
    return this.createPrResult;
  }
}

// ---------------------------------------------------------------------------
// Stub Git for abort-failure test
// ---------------------------------------------------------------------------

class AbortFailingGit {
  abortCalled = false;

  async fetchRemote(): Promise<void> {}
  async localBranchExists(): Promise<boolean> { return true; }
  async remoteBranchExists(): Promise<boolean> { return false; }
  async checkout(): Promise<void> {}
  async stageAll(): Promise<void> {}
  async hasStagedChanges(): Promise<boolean> { return false; }
  async commit(): Promise<void> {}
  async rebase(): Promise<never> { throw new OkhError("GIT_ERROR", "conflict during rebase"); }
  async abortRebase(): Promise<never> {
    this.abortCalled = true;
    throw new OkhError("GIT_ERROR", "abort failed");
  }
  async push(): Promise<void> {}
  async currentBranch(): Promise<string> { return "user/test/hub"; }
  async aheadBehind(): Promise<null> { return null; }
  async isValidBranchName(): Promise<boolean> { return true; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function cloneOrigin(bare: string): Promise<string> {
  const dest = await makeTempDir("okh-git-backend-clone-");
  cleanups.push(dest);
  await testRun("git", ["clone", bare, dest]);
  return dest;
}

function makeEntry(
  localPath: string,
  mode: "auto" | "shared" = "auto",
  config: Record<string, unknown> = {},
): ContainerEntry {
  return {
    name: "test-hub",
    backend: { type: "git", config: { origin: "https://example.com/repo.git" } },
    localPath,
    sync: { mode, config },
    addedAt: "2026-07-02T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("GitBackend — resolveBackendConfig", () => {
  const git = new Git(testRun);
  const gh = new FakeGh();
  const backend = new GitBackend(git, gh as unknown as Gh);

  it("rejects config missing origin", () => {
    expect(() => backend.resolveBackendConfig({})).toThrow(OkhError);
  });

  it("rejects config with unknown keys", () => {
    expect(() =>
      backend.resolveBackendConfig({ origin: "https://example.com/repo.git", extra: "x" }),
    ).toThrow(OkhError);
  });

  it("rejects remote-helper URL", () => {
    expect(() =>
      backend.resolveBackendConfig({ origin: "ext::sh -c malicious" }),
    ).toThrow(OkhError);
  });

  it("accepts valid https URL", () => {
    const result = backend.resolveBackendConfig({ origin: "https://github.com/org/repo.git" });
    expect(result).toEqual({ origin: "https://github.com/org/repo.git" });
  });

  it("accepts git@ scp-style URL", () => {
    const result = backend.resolveBackendConfig({ origin: "git@github.com:org/repo.git" });
    expect(result).toEqual({ origin: "git@github.com:org/repo.git" });
  });
});

describe("GitBackend — resolveSync auto mode", () => {
  const git = new Git(testRun);
  const gh = new FakeGh();
  const backend = new GitBackend(git, gh as unknown as Gh);

  it("accepts empty config and returns auto selection", async () => {
    const result = await backend.resolveSync(
      { mode: "auto", config: {} },
      { containerName: "test-hub" },
    );
    expect(result).toEqual({ mode: "auto", config: {} });
  });

  it("rejects unknown config keys", async () => {
    await expect(
      backend.resolveSync({ mode: "auto", config: { extra: true } }, { containerName: "test-hub" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("GitBackend — resolveSync shared mode", () => {
  const git = new Git(testRun);

  it("defaults branch from gh.currentLogin when no branch specified", async () => {
    const gh = new FakeGh();
    gh.loginResult = "alice";
    const backend = new GitBackend(git, gh as unknown as Gh);

    const result = await backend.resolveSync(
      { mode: "shared", config: {} },
      { containerName: "test-hub" },
    );

    expect(result).toEqual({ mode: "shared", config: { branch: "user/alice/hub" } });
    expect(gh.loginCalls).toBe(1);
  });

  it("uses explicit branch without calling login", async () => {
    const gh = new FakeGh();
    const backend = new GitBackend(git, gh as unknown as Gh);

    const result = await backend.resolveSync(
      { mode: "shared", config: { branch: "user/alice/hub" } },
      { containerName: "test-hub" },
    );

    expect(result).toEqual({ mode: "shared", config: { branch: "user/alice/hub" } });
    expect(gh.loginCalls).toBe(0);
  });

  it("rejects branch name 'main'", async () => {
    const gh = new FakeGh();
    const backend = new GitBackend(git, gh as unknown as Gh);

    await expect(
      backend.resolveSync(
        { mode: "shared", config: { branch: "main" } },
        { containerName: "test-hub" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringContaining("main") });
  });

  it("rejects invalid branch name", async () => {
    const gh = new FakeGh();
    const backend = new GitBackend(git, gh as unknown as Gh);

    await expect(
      backend.resolveSync(
        { mode: "shared", config: { branch: "bad..name" } },
        { containerName: "test-hub" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects unknown config keys", async () => {
    const gh = new FakeGh();
    const backend = new GitBackend(git, gh as unknown as Gh);

    await expect(
      backend.resolveSync(
        { mode: "shared", config: { extra: "x" } },
        { containerName: "test-hub" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("wraps login failure with actionable OkhError mentioning gh auth login", async () => {
    const gh = new FakeGh();
    gh.loginResult = new OkhError("GH_ERROR", "not authenticated");
    const backend = new GitBackend(git, gh as unknown as Gh);

    const err = await backend
      .resolveSync({ mode: "shared", config: {} }, { containerName: "test-hub" })
      .catch((e) => e as OkhError);

    expect(err).toBeInstanceOf(OkhError);
    expect(err.code).toBe("GH_ERROR");
    expect(err.hint).toMatch(/gh auth login|explicit branch/i);
  });
});

describe("GitBackend — actions", () => {
  const git = new Git(testRun);
  const gh = new FakeGh();
  const backend = new GitBackend(git, gh as unknown as Gh);

  it("returns [] for auto mode", () => {
    expect(backend.actions({ mode: "auto", config: {} })).toEqual([]);
  });

  it("returns ['publish-pr'] for shared mode", () => {
    expect(backend.actions({ mode: "shared", config: { branch: "user/test/hub" } })).toEqual([
      "publish-pr",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Auto sync
// ---------------------------------------------------------------------------

describe("GitBackend — auto sync", () => {
  it("commits dirty files, pushes to origin, outcome synced", async () => {
    const origin = await makeOrigin();
    cleanups.push(origin.replace("origin.git", "").trimEnd());
    const root = await cloneOrigin(origin);
    await writeFile(join(root, "note.md"), "hello", "utf8");

    const backend = new GitBackend(new Git(testRun), new FakeGh() as unknown as Gh);
    const entry = makeEntry(root);
    const result = await backend.sync({ entry, validation: { ok: true, issues: [] } });

    expect(result.mode).toBe("auto");
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.outcome).toBe("synced");
    expect(result.branch).toBeTruthy();

    // Verify file is on origin
    const verify = await makeTempDir("okh-verify-");
    cleanups.push(verify);
    await testRun("git", ["clone", origin, verify]);
    const noteExists = await stat(join(verify, "note.md")).then(() => true, () => false);
    expect(noteExists).toBe(true);
  });

  it("integrates remote changes via fast-forward, outcome synced", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);

    // Initial sync to set upstream
    const backend = new GitBackend(new Git(testRun), new FakeGh() as unknown as Gh);
    const entry = makeEntry(root);
    await writeFile(join(root, "local.md"), "x", "utf8");
    await backend.sync({ entry, validation: { ok: true, issues: [] } });

    // Remote advances
    await pushToOrigin(origin, "remote.md", "from remote");

    // Second sync: no local commit, but pulls remote work
    const result = await backend.sync({ entry, validation: { ok: true, issues: [] } });
    expect(result.committed).toBe(false);
    expect(result.outcome).toBe("synced");

    // Local should now have remote file
    const remoteFileExists = await stat(join(root, "remote.md")).then(() => true, () => false);
    expect(remoteFileExists).toBe(true);
  });

  it("outcome is up-to-date when nothing to commit and remote is current", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);

    // Push once to establish upstream
    const backend = new GitBackend(new Git(testRun), new FakeGh() as unknown as Gh);
    const entry = makeEntry(root);
    await writeFile(join(root, "seed.md"), "x", "utf8");
    await backend.sync({ entry, validation: { ok: true, issues: [] } });

    // Second sync with nothing changed: fetch shows behind=0 → accurately up-to-date
    const result = await backend.sync({ entry, validation: { ok: true, issues: [] } });
    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(true);
    // behind=0 and no commit → accurately up-to-date
    expect(result.outcome).toBe("up-to-date");
  });

  it("throws GIT_ERROR with diverged-branch guidance when pull fails", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);
    await writeFile(join(root, "local.md"), "x", "utf8");

    // Remote also advances → diverged
    await pushToOrigin(origin, "remote.md", "y");

    const backend = new GitBackend(new Git(testRun), new FakeGh() as unknown as Gh);
    const entry = makeEntry(root);

    await expect(backend.sync({ entry, validation: { ok: true, issues: [] } })).rejects.toMatchObject({
      code: "GIT_ERROR",
      hint: expect.stringContaining("diverged"),
    });
  });

  it("rejects any action with INVALID_ARGUMENT error", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);

    const backend = new GitBackend(new Git(testRun), new FakeGh() as unknown as Gh);
    const entry = makeEntry(root);

    await expect(
      backend.sync({ entry, validation: { ok: true, issues: [] }, action: "publish-pr" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

// ---------------------------------------------------------------------------
// Shared sync
// ---------------------------------------------------------------------------

describe("GitBackend — shared sync", () => {
  it("creates branch from origin/main when not found locally or remotely", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);
    const branch = "user/test/hub";

    const backend = new GitBackend(new Git(testRun), new FakeGh() as unknown as Gh);
    const entry = makeEntry(root, "shared", { branch });
    const result = await backend.sync({ entry, validation: { ok: true, issues: [] } });

    expect(result.mode).toBe("shared");
    expect(result.pushed).toBe(true);
    expect(result.branch).toBe(branch);

    // Branch exists on origin
    const { stdout } = await testRun("git", ["ls-remote", "--heads", origin, branch]);
    expect(stdout).toContain(branch);
  });

  it("remains checked out on configured branch after sync", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);
    const branch = "user/test/hub";

    const backend = new GitBackend(new Git(testRun), new FakeGh() as unknown as Gh);
    const entry = makeEntry(root, "shared", { branch });
    await backend.sync({ entry, validation: { ok: true, issues: [] } });

    const git = new Git(testRun);
    const currentBranch = await git.currentBranch(root);
    expect(currentBranch).toBe(branch);
  });

  it("tracks existing remote shared branch when no local branch exists", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);
    const branch = "user/test/hub";

    // Push the branch to origin from another clone
    const other = await makeTempDir("okh-other-");
    cleanups.push(other);
    await testRun("git", ["clone", origin, other]);
    await testRun("git", ["checkout", "-b", branch], { cwd: other });
    await writeFile(join(other, "existing.md"), "from other", "utf8");
    await testRun("git", ["add", "-A"], { cwd: other });
    await testRun("git", ["commit", "-m", "existing commit"], { cwd: other });
    await testRun("git", ["push", "origin", branch], { cwd: other });

    // Local clone has no local branch yet
    const backend = new GitBackend(new Git(testRun), new FakeGh() as unknown as Gh);
    const entry = makeEntry(root, "shared", { branch });
    const result = await backend.sync({ entry, validation: { ok: true, issues: [] } });

    expect(result.pushed).toBe(true);

    // Local should have the file from the remote branch
    const existingFileExists = await stat(join(root, "existing.md")).then(() => true, () => false);
    expect(existingFileExists).toBe(true);

    // Branch remains checked out
    const git = new Git(testRun);
    expect(await git.currentBranch(root)).toBe(branch);
  });

  it("rebases local commit onto updated origin/main before push", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);
    const branch = "user/test/hub";

    const backend = new GitBackend(new Git(testRun), new FakeGh() as unknown as Gh);
    const entry = makeEntry(root, "shared", { branch });

    // First sync: creates branch
    await backend.sync({ entry, validation: { ok: true, issues: [] } });

    // Remote main advances
    await pushToOrigin(origin, "remote-update.md", "from main");

    // Local change
    await writeFile(join(root, "local-update.md"), "local work", "utf8");

    // Second sync: should rebase local commit onto new origin/main
    const result = await backend.sync({ entry, validation: { ok: true, issues: [] } });
    expect(result.committed).toBe(true);
    expect(result.outcome).toBe("synced");

    // Verify remote-update.md is present (from rebase onto new origin/main)
    const remoteUpdateExists = await stat(join(root, "remote-update.md")).then(() => true, () => false);
    expect(remoteUpdateExists).toBe(true);
  });

  it("repeated sync succeeds without re-creating branch", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);
    const branch = "user/test/hub";

    const backend = new GitBackend(new Git(testRun), new FakeGh() as unknown as Gh);
    const entry = makeEntry(root, "shared", { branch });

    await backend.sync({ entry, validation: { ok: true, issues: [] } });
    // Second sync with no changes
    const result = await backend.sync({ entry, validation: { ok: true, issues: [] } });

    expect(result.pushed).toBe(true);
    const git = new Git(testRun);
    expect(await git.currentBranch(root)).toBe(branch);
  });

  it("rebase conflict: aborts cleanly, local commit preserved, OkhError thrown", async () => {
    const origin = await makeOrigin({ "shared.md": "base content\n" });
    const root = await cloneOrigin(origin);
    const branch = "user/test/hub";

    const backend = new GitBackend(new Git(testRun), new FakeGh() as unknown as Gh);
    const entry = makeEntry(root, "shared", { branch });

    // First sync: creates shared branch on current origin/main
    await backend.sync({ entry, validation: { ok: true, issues: [] } });

    // Remote main advances with conflicting change to shared.md
    await pushToOrigin(origin, "shared.md", "origin change\n");

    // Local change to same file (will conflict on rebase)
    await writeFile(join(root, "shared.md"), "local change\n", "utf8");

    // Second sync: rebase will conflict
    await expect(backend.sync({ entry, validation: { ok: true, issues: [] } })).rejects.toMatchObject({
      code: "GIT_ERROR",
    });

    // No rebase in progress
    const rebaseMergeExists = await stat(join(root, ".git", "rebase-merge")).then(() => true, () => false);
    expect(rebaseMergeExists).toBe(false);

    // Local commit still at HEAD (committed before rebase attempt)
    const { stdout: logOut } = await testRun("git", ["log", "--oneline", "-1"], { cwd: root });
    expect(logOut.trim()).toMatch(/okh: sync/);
  });

  it("abort failure reports both rebase and abort errors", async () => {
    const fakeRoot = await makeTempDir("okh-abort-fail-");
    cleanups.push(fakeRoot);

    const stubGit = new AbortFailingGit();
    const backend = new GitBackend(stubGit as unknown as Git, new FakeGh() as unknown as Gh);
    const entry = makeEntry(fakeRoot, "shared", { branch: "user/test/hub" });

    const err: unknown = await backend
      .sync({ entry, validation: { ok: true, issues: [] } })
      .catch((e) => e);

    expect(stubGit.abortCalled).toBe(true);

    const isAggregate = err instanceof AggregateError;
    if (isAggregate) {
      expect((err as AggregateError).errors).toHaveLength(2);
    } else {
      // OkhError containing both messages
      const msg = (err as Error).message;
      expect(msg).toMatch(/conflict|rebase/i);
      expect(msg).toMatch(/abort/i);
    }
  });

  it("plain shared sync never calls Gh PR methods", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);
    const fakeGh = new FakeGh();

    const backend = new GitBackend(new Git(testRun), fakeGh as unknown as Gh);
    const entry = makeEntry(root, "shared", { branch: "user/test/hub" });
    await backend.sync({ entry, validation: { ok: true, issues: [] } });

    expect(fakeGh.findCalls).toHaveLength(0);
    expect(fakeGh.createCalls).toHaveLength(0);
    expect(fakeGh.loginCalls).toBe(0);
  });

  it("rejects unknown action listing publish-pr as supported", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);

    const backend = new GitBackend(new Git(testRun), new FakeGh() as unknown as Gh);
    const entry = makeEntry(root, "shared", { branch: "user/test/hub" });

    await expect(
      backend.sync({ entry, validation: { ok: true, issues: [] }, action: "unknown-action" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("publish-pr"),
    });
  });
});

// ---------------------------------------------------------------------------
// publish-pr
// ---------------------------------------------------------------------------

describe("GitBackend — publish-pr", () => {
  it("syncs first then creates PR with correct base and head", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);
    const branch = "user/test/hub";
    await writeFile(join(root, "note.md"), "hello", "utf8");

    const fakeGh = new FakeGh();
    const backend = new GitBackend(new Git(testRun), fakeGh as unknown as Gh);
    const entry = makeEntry(root, "shared", { branch });

    const result = await backend.sync({
      entry,
      validation: { ok: true, issues: [] },
      action: "publish-pr",
    });

    expect(result.requestedAction).toBe("publish-pr");
    expect(result.outcome).toBe("published");
    expect(result.prUrl).toBe("https://github.com/test/repo/pull/1");
    expect(result.branch).toBe(branch);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);

    expect(fakeGh.createCalls).toHaveLength(1);
    expect(fakeGh.createCalls[0]).toMatchObject({ base: "main", head: branch });
    expect(fakeGh.createCalls[0]!.body).toBe("Automated OKH sync.");
  });

  it("reuses existing open PR without creating a new one", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);
    const branch = "user/test/hub";

    const fakeGh = new FakeGh();
    fakeGh.findPrResult = "https://github.com/test/repo/pull/5";

    const backend = new GitBackend(new Git(testRun), fakeGh as unknown as Gh);
    const entry = makeEntry(root, "shared", { branch });

    const result = await backend.sync({
      entry,
      validation: { ok: true, issues: [] },
      action: "publish-pr",
    });

    expect(result.prUrl).toBe("https://github.com/test/repo/pull/5");
    expect(result.outcome).toBe("published");
    expect(fakeGh.createCalls).toHaveLength(0);
    expect(fakeGh.findCalls).toHaveLength(1);
    expect(fakeGh.findCalls[0]).toMatchObject({ base: "main", head: branch });
  });

  it("uses message as PR title when provided", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);
    const branch = "user/test/hub";

    const fakeGh = new FakeGh();
    const backend = new GitBackend(new Git(testRun), fakeGh as unknown as Gh);
    const entry = makeEntry(root, "shared", { branch });

    await backend.sync({
      entry,
      validation: { ok: true, issues: [] },
      action: "publish-pr",
      message: "My custom title",
    });

    expect(fakeGh.createCalls[0]).toMatchObject({ title: "My custom title" });
  });

  it("defaults PR title to 'okh sync: <name>' when no message", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);
    const branch = "user/test/hub";

    const fakeGh = new FakeGh();
    const backend = new GitBackend(new Git(testRun), fakeGh as unknown as Gh);
    const entry = makeEntry(root, "shared", { branch });

    await backend.sync({
      entry,
      validation: { ok: true, issues: [] },
      action: "publish-pr",
    });

    expect(fakeGh.createCalls[0]).toMatchObject({ title: "okh sync: test-hub" });
  });

  it("PR create failure leaves branch pushed; retry succeeds", async () => {
    const origin = await makeOrigin();
    const root = await cloneOrigin(origin);
    const branch = "user/test/hub";
    await writeFile(join(root, "note.md"), "hello", "utf8");

    const fakeGh = new FakeGh();
    fakeGh.createPrResult = new OkhError("GH_ERROR", "create PR failed");

    const backend = new GitBackend(new Git(testRun), fakeGh as unknown as Gh);
    const entry = makeEntry(root, "shared", { branch });

    // First attempt: sync succeeds, PR create fails
    await expect(
      backend.sync({ entry, validation: { ok: true, issues: [] }, action: "publish-pr" }),
    ).rejects.toMatchObject({ code: "GH_ERROR" });

    // Branch was pushed to origin despite PR failure
    const { stdout: remoteRefs } = await testRun("git", ["ls-remote", "--heads", origin]);
    expect(remoteRefs).toContain(branch);

    // Retry: no new commit needed, PR succeeds
    fakeGh.createPrResult = "https://github.com/test/repo/pull/99";
    const result = await backend.sync({
      entry,
      validation: { ok: true, issues: [] },
      action: "publish-pr",
    });

    expect(result.outcome).toBe("published");
    expect(result.prUrl).toBe("https://github.com/test/repo/pull/99");
  });
});
