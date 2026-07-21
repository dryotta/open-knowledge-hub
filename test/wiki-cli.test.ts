import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runWikiCli } from "../src/wiki/cli.js";
import { saveModuleManifest } from "../src/modules/manifest.js";

const exec = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

async function ghRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cli-repo-"));
  await exec("git", ["init", "-b", "main", dir], { env: GIT_ENV });
  await exec("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: dir, env: GIT_ENV });
  await mkdir(join(dir, "design"), { recursive: true });
  await saveModuleManifest(join(dir, "design"), { type: "knowledge", description: "D" });
  await writeFile(join(dir, "design", "index.md"), "# Design");
  await exec("git", ["add", "-A"], { cwd: dir, env: GIT_ENV });
  await exec("git", ["commit", "-m", "init"], { cwd: dir, env: GIT_ENV });
  return dir;
}

describe("runWikiCli", () => {
  it("dry-run returns exit 0", async () => {
    const repo = await ghRepo();
    const code = await runWikiCli(["wiki", "publish", "--dry-run", "--repo", repo]);
    expect(code).toBe(0);
  });

  it("unknown subcommand returns exit 2", async () => {
    const code = await runWikiCli(["wiki", "frobnicate"]);
    expect(code).toBe(2);
  });
});
