import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { reverseSyncWiki, type ReverseResolveResult } from "../src/wiki/reverse.js";
import { saveModuleManifest } from "../src/modules/manifest.js";
import type { WikiReverseMode } from "../src/modules/manifest.js";
import { WIKI_BOT_EMAIL, WIKI_BOT_NAME } from "../src/wiki/constants.js";

const exec = promisify(execFile);
const H = { GIT_AUTHOR_NAME: "Ann", GIT_AUTHOR_EMAIL: "ann@human", GIT_COMMITTER_NAME: "Ann", GIT_COMMITTER_EMAIL: "ann@human" };
const BOT = {
  GIT_AUTHOR_NAME: WIKI_BOT_NAME,
  GIT_AUTHOR_EMAIL: WIKI_BOT_EMAIL,
  GIT_COMMITTER_NAME: WIKI_BOT_NAME,
  GIT_COMMITTER_EMAIL: WIKI_BOT_EMAIL,
};

async function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: { ...process.env, ...extraEnv } });
  return stdout;
}

async function commitAll(dir: string, message: string, env: Record<string, string>): Promise<void> {
  await git(dir, ["add", "-A"], env);
  await git(dir, ["commit", "-m", message], env);
}

const EED_SOURCE = `---\ntitle: EED\nokf_version: "0.1"\n---\n# EED\n\nold body.\n`;

/**
 * Source repo with two flagged modules: `kb` (knowledge) and `ops` (skills).
 * `kb` uses the given reverse mode; `ops` defaults to pr unless overridden.
 */
async function makeSourceRepo(kbMode?: WikiReverseMode, opsMode?: WikiReverseMode): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "okh-src-"));
  await git(dir, ["init", "-b", "main", "."], H);

  const kb = join(dir, "kb");
  await mkdir(join(kb, "sources"), { recursive: true });
  await mkdir(join(kb, "cross-cutting"), { recursive: true });
  await saveModuleManifest(kb, {
    type: "knowledge",
    description: "KB",
    "wiki-sync": true,
    ...(kbMode ? { "wiki-sync-reverse-mode": kbMode } : {}),
  });
  await writeFile(join(kb, "index.md"), "# KB\n\nWelcome.\n");
  await writeFile(join(kb, "sources", "eed.md"), EED_SOURCE);
  await writeFile(join(kb, "cross-cutting", "id-pivots.md"), "# ID pivots\n\nPivots.\n");

  const ops = join(dir, "ops");
  await mkdir(ops, { recursive: true });
  await saveModuleManifest(ops, {
    type: "skills",
    description: "Ops",
    "wiki-sync": true,
    ...(opsMode ? { "wiki-sync-reverse-mode": opsMode } : {}),
  });
  await writeFile(join(ops, "deploy.md"), "# Deploy\n\ndeploy steps.\n");

  await commitAll(dir, "seed source", H);
  return dir;
}

/** Wiki repo whose BASE commit is bot-authored and mirrors the namespaced pages. */
async function makeWikiRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "okh-wiki-"));
  await git(dir, ["init", "-b", "master", "."], BOT);
  await writeFile(join(dir, "Home.md"), "# widgets\n");
  await writeFile(join(dir, "kb.md"), "# KB\n\nWelcome.\n");
  await writeFile(join(dir, "kb-sources-eed.md"), "# EED\n\nold body.\n");
  await writeFile(join(dir, "kb-cross-cutting-id-pivots.md"), "# ID pivots\n\nPivots.\n");
  await writeFile(join(dir, "ops.md"), "# Ops\n");
  await writeFile(join(dir, "ops-deploy.md"), "# Deploy\n\ndeploy steps.\n");
  await writeFile(join(dir, "_Header.md"), "gen\n");
  await writeFile(join(dir, "_Sidebar.md"), "[Home](Home)\n");
  await writeFile(join(dir, "_Footer.md"), "gen\n");
  await commitAll(dir, "Publish wiki from 0000000", BOT);
  return dir;
}

async function makeOriginBare(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "okh-origin-"));
  await git(dir, ["init", "--bare", "-b", "main", "."], H);
  return dir;
}

function resolver(originBare: string, wikiRepo: string): () => Promise<ReverseResolveResult> {
  return async () => ({
    owner: "acme",
    repo: "widgets",
    repoUrl: originBare,
    wikiRemoteUrl: wikiRepo,
    defaultBranch: "main",
  });
}

describe("reverseSyncWiki", () => {
  it("reports no-baseline when the wiki has no bot commit", async () => {
    const src = await makeSourceRepo("pr");
    const wiki = await mkdtemp(join(tmpdir(), "okh-wiki-"));
    await git(wiki, ["init", "-b", "master", "."], H);
    await writeFile(join(wiki, "Home.md"), "# widgets\n");
    await commitAll(wiki, "human first", H);
    const res = await reverseSyncWiki(src, { resolve: resolver("unused", wiki) });
    expect(res.outcome).toBe("no-baseline");
  });

  it("reports up-to-date when only the bot commit exists", async () => {
    const src = await makeSourceRepo("pr");
    const wiki = await makeWikiRepo();
    const res = await reverseSyncWiki(src, { resolve: resolver("unused", wiki) });
    expect(res.outcome).toBe("up-to-date");
  });

  it("dry-run modifies a page: preserves frontmatter and un-rewrites slug links", async () => {
    const src = await makeSourceRepo("pr");
    const wiki = await makeWikiRepo();
    await writeFile(join(wiki, "kb-sources-eed.md"), "# EED\n\nnew body. See [pivots](kb-cross-cutting-id-pivots).\n");
    await commitAll(wiki, "human edit", H);

    const res = await reverseSyncWiki(src, { dryRun: true, resolve: resolver("unused", wiki) });
    expect(res.outcome).toBe("dry-run");
    expect(res.counts.modified).toBe(1);

    const written = await readFile(join(src, "kb", "sources", "eed.md"), "utf8");
    expect(written).toContain(`okf_version: "0.1"`);
    expect(written).toContain("new body.");
    expect(written).toContain("[pivots](../cross-cutting/id-pivots.md)");
  });

  it("dry-run maps a module landing edit back to its index.md", async () => {
    const src = await makeSourceRepo("pr");
    const wiki = await makeWikiRepo();
    await writeFile(join(wiki, "kb.md"), "# KB\n\nUpdated welcome.\n");
    await commitAll(wiki, "human landing", H);

    const res = await reverseSyncWiki(src, { dryRun: true, resolve: resolver("unused", wiki) });
    expect(res.counts.modified).toBe(1);
    const written = await readFile(join(src, "kb", "index.md"), "utf8");
    expect(written).toContain("Updated welcome.");
  });

  it("dry-run ignores generated Home edits (unmapped)", async () => {
    const src = await makeSourceRepo("pr");
    const wiki = await makeWikiRepo();
    await writeFile(join(wiki, "Home.md"), "# widgets\n\nedited landing.\n");
    await commitAll(wiki, "human home", H);

    const res = await reverseSyncWiki(src, { dryRun: true, resolve: resolver("unused", wiki) });
    expect(res.outcome).toBe("disabled"); // nothing landed
  });

  it("dry-run maps a new namespaced page to a flat file in that module", async () => {
    const src = await makeSourceRepo("pr");
    const wiki = await makeWikiRepo();
    await writeFile(join(wiki, "ops-rollback.md"), "# Rollback\n\nsteps.\n");
    await commitAll(wiki, "human add", H);

    const res = await reverseSyncWiki(src, { dryRun: true, resolve: resolver("unused", wiki) });
    expect(res.counts.added).toBe(1);
    const written = await readFile(join(src, "ops", "rollback.md"), "utf8");
    expect(written).toBe("# Rollback\n\nsteps.\n");
  });

  it("dry-run deletes the mapped source file for a deleted page", async () => {
    const src = await makeSourceRepo("pr");
    const wiki = await makeWikiRepo();
    await rm(join(wiki, "kb-sources-eed.md"));
    await commitAll(wiki, "human delete", H);

    const res = await reverseSyncWiki(src, { dryRun: true, resolve: resolver("unused", wiki) });
    expect(res.counts.deleted).toBe(1);
    await expect(readFile(join(src, "kb", "sources", "eed.md"), "utf8")).rejects.toThrow();
  });

  it("pr mode pushes a branch and opens a PR", async () => {
    const src = await makeSourceRepo("pr");
    const wiki = await makeWikiRepo();
    const origin = await makeOriginBare();
    await writeFile(join(wiki, "kb-sources-eed.md"), "# EED\n\nedited.\n");
    await commitAll(wiki, "human edit", H);

    const calls: Array<Record<string, unknown>> = [];
    const res = await reverseSyncWiki(src, {
      resolve: resolver(origin, wiki),
      runId: "run-42",
      openPr: async (args) => {
        calls.push(args as unknown as Record<string, unknown>);
        return { number: 5, url: "https://github.com/acme/widgets/pull/5" };
      },
    });

    expect(res.outcome).toBe("pr-opened");
    expect(res.prNumber).toBe(5);
    expect(calls[0].head).toBe("okh/wiki-sync/run-42");
    expect(calls[0].base).toBe("main");
    const refs = await git(origin, ["ls-remote", "--heads", "."]);
    expect(refs).toContain("okh/wiki-sync/run-42");
  });

  it("direct mode commits straight to the default branch", async () => {
    const src = await makeSourceRepo("direct");
    const wiki = await makeWikiRepo();
    const origin = await makeOriginBare();
    await writeFile(join(wiki, "kb-sources-eed.md"), "# EED\n\nedited.\n");
    await commitAll(wiki, "human edit", H);

    const res = await reverseSyncWiki(src, { resolve: resolver(origin, wiki) });
    expect(res.outcome).toBe("committed");
    expect(res.commit).toBeTruthy();
    const refs = await git(origin, ["ls-remote", "--heads", "."]);
    expect(refs).toContain("refs/heads/main");
  });

  it("partitions edits by module mode: direct commit + combined PR in one run", async () => {
    // kb is direct, ops is pr. Editing a page in each lands both a commit and a PR.
    const src = await makeSourceRepo("direct", "pr");
    const wiki = await makeWikiRepo();
    const origin = await makeOriginBare();
    await writeFile(join(wiki, "kb-sources-eed.md"), "# EED\n\nkb edit.\n");
    await writeFile(join(wiki, "ops-deploy.md"), "# Deploy\n\nops edit.\n");
    await commitAll(wiki, "human edits", H);

    let prArgs: { body?: string } | undefined;
    const res = await reverseSyncWiki(src, {
      resolve: resolver(origin, wiki),
      runId: "run-99",
      openPr: async (args) => {
        prArgs = args;
        return { number: 7, url: "https://github.com/acme/widgets/pull/7" };
      },
    });

    expect(res.outcome).toBe("committed+pr-opened");
    expect(res.prNumber).toBe(7);
    const refs = await git(origin, ["ls-remote", "--heads", "."]);
    expect(refs).toContain("refs/heads/main");
    expect(refs).toContain("okh/wiki-sync/run-99");
    // Both edits landed, but the PR body counts and file list are pr-scoped only.
    expect(res.counts.modified).toBe(2);
    expect(prArgs?.body).toContain("Modified: 1");
    expect(prArgs?.body).toContain("`ops/deploy.md`");
    expect(prArgs?.body).not.toContain("`kb/sources/eed.md`");
  });

  it("no-ops (disabled) when the only edited module is off-mode", async () => {
    const src = await makeSourceRepo("off", "off");
    const wiki = await makeWikiRepo();
    await writeFile(join(wiki, "kb-sources-eed.md"), "# EED\n\nedited.\n");
    await commitAll(wiki, "human edit", H);

    const res = await reverseSyncWiki(src, { resolve: resolver("unused", wiki) });
    expect(res.outcome).toBe("disabled");
  });
});
