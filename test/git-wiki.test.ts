import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Git } from "../src/git/git.js";

const exec = promisify(execFile);
const git = new Git();

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "okh-gitw-"));
  await git.init(dir);
  return dir;
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  await mkdir(join(dir, rel, ".."), { recursive: true }).catch(() => {});
  const abs = join(dir, rel);
  await mkdir(join(abs, ".."), { recursive: true }).catch(() => {});
  await writeFile(abs, content, "utf8");
}

describe("Git.commitAs", () => {
  it("commits with an explicit committer identity", async () => {
    const dir = await repo();
    try {
      await write(dir, "a.md", "hi");
      await git.stageAll(dir);
      await git.commitAs(dir, "seed", "OKH Wiki Bot", "okh-wiki-bot@users.noreply.github.com");
      const { stdout } = await exec("git", ["log", "-1", "--format=%cn|%ce"], { cwd: dir });
      expect(stdout.trim()).toBe("OKH Wiki Bot|okh-wiki-bot@users.noreply.github.com");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Git.logLastCommitBy", () => {
  it("returns the newest commit hash by that committer email, else null", async () => {
    const dir = await repo();
    try {
      await write(dir, "a.md", "1");
      await git.stageAll(dir);
      await git.commitAs(dir, "bot commit", "Bot", "bot@example.com");
      const botSha = await git.currentCommit(dir);

      await write(dir, "a.md", "2");
      await git.stageAll(dir);
      await git.commitAs(dir, "human commit", "Human", "human@example.com");

      expect(await git.logLastCommitBy(dir, "bot@example.com")).toBe(botSha);
      expect(await git.logLastCommitBy(dir, "nobody@example.com")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Git.nameStatus", () => {
  it("reports added, modified, deleted and renamed markdown between two commits", async () => {
    const dir = await repo();
    try {
      await write(dir, "keep.md", "keep");
      await write(dir, "gone.md", "gone");
      await write(dir, "old.md", "some longer content that survives a rename cleanly");
      await git.stageAll(dir);
      await git.commitAs(dir, "base", "Bot", "bot@example.com");
      const base = await git.currentCommit(dir);

      await write(dir, "keep.md", "keep edited");
      await write(dir, "fresh.md", "fresh");
      await rm(join(dir, "gone.md"));
      await rm(join(dir, "old.md"));
      await write(dir, "new.md", "some longer content that survives a rename cleanly");
      await git.stageAll(dir);
      await git.commitAs(dir, "head", "Human", "human@example.com");

      const out = await git.nameStatus(dir, `${base}..HEAD`);
      expect(out).toMatch(/^M\tkeep\.md$/m);
      expect(out).toMatch(/^A\tfresh\.md$/m);
      expect(out).toMatch(/^D\tgone\.md$/m);
      expect(out).toMatch(/^R\d+\told\.md\tnew\.md$/m);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
