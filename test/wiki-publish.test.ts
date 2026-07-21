import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildAndPublishWiki } from "../src/wiki/publish.js";
import { saveModuleManifest } from "../src/modules/manifest.js";

const exec = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

async function writeWikiConfig(dir: string, body: string): Promise<void> {
  await mkdir(join(dir, ".okh"), { recursive: true });
  await writeFile(join(dir, ".okh", "wiki.yml"), body);
}

async function fixtureRepo(configBody?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "okh-repo-"));
  await exec("git", ["init", "-b", "main", dir], { env: GIT_ENV });
  await mkdir(join(dir, "design"), { recursive: true });
  await saveModuleManifest(join(dir, "design"), { type: "knowledge", description: "Design docs" });
  await writeFile(join(dir, "design", "index.md"), "# Design\n\nOverview.");
  await writeFile(join(dir, "design", "retry.md"), "---\ntitle: Retry\n---\n# Retry\n\nBody.");
  await mkdir(join(dir, "skills"), { recursive: true });
  await saveModuleManifest(join(dir, "skills"), { type: "skills", description: "S" });
  await writeFile(join(dir, "skills", "index.md"), "# Skills");
  if (configBody !== undefined) await writeWikiConfig(dir, configBody);
  await exec("git", ["add", "-A"], { cwd: dir, env: GIT_ENV });
  await exec("git", ["commit", "-m", "init"], { cwd: dir, env: GIT_ENV });
  return dir;
}

const resolveStub = async () => ({
  owner: "acme",
  repo: "widgets",
  repoUrl: "https://github.com/acme/widgets",
  wikiRemoteUrl: "",
  commit: "abcdef1234567",
});

describe("buildAndPublishWiki module selection", () => {
  it("rejects when no module is configured", async () => {
    const repo = await fixtureRepo();
    await expect(
      buildAndPublishWiki(repo, { dryRun: true, resolve: async () => ({ ...(await resolveStub()), wikiRemoteUrl: "unused" }) }),
    ).rejects.toThrow(/module:/);
  });

  it("rejects an unknown module and lists the available ones", async () => {
    const repo = await fixtureRepo("module: nope\n");
    await expect(
      buildAndPublishWiki(repo, { dryRun: true, resolve: async () => ({ ...(await resolveStub()), wikiRemoteUrl: "unused" }) }),
    ).rejects.toThrow(/design/);
  });

  it("dry-run renders the selected knowledge module", async () => {
    const repo = await fixtureRepo("module: design\n");
    const res = await buildAndPublishWiki(repo, {
      dryRun: true,
      now: () => new Date("2026-07-20T00:00:00Z"),
      resolve: async () => ({ ...(await resolveStub()), wikiRemoteUrl: "unused" }),
    });
    expect(res.outcome).toBe("dry-run");
    expect(res.pages).toBeGreaterThanOrEqual(3);
    expect(res.wikiUrl).toBe("https://github.com/acme/widgets/wiki");
  });

  it("publishes to a bare wiki remote", async () => {
    const repo = await fixtureRepo("module: design\n");
    const wiki = await mkdtemp(join(tmpdir(), "okh-wiki-"));
    await exec("git", ["init", "--bare", "-b", "master", wiki], { env: GIT_ENV });
    const res = await buildAndPublishWiki(repo, {
      now: () => new Date("2026-07-20T00:00:00Z"),
      resolve: async () => ({ ...(await resolveStub()), wikiRemoteUrl: wiki }),
    });
    expect(res.outcome).toBe("published");
  });
});
