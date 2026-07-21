import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publishWikiSite } from "../src/wiki/repo.js";
import type { WikiSite } from "../src/wiki/renderer.js";

const exec = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

async function bareRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-bare-"));
  await exec("git", ["init", "--bare", "-b", "master", dir], { env: GIT_ENV });
  return dir;
}

function site(pages: { path: string; content: string }[]): WikiSite {
  return { pages, assets: [], warnings: [] };
}

describe("publishWikiSite", () => {
  it("publishes into an empty bare wiki on master", async () => {
    const remote = await bareRepo();
    const workdir = await mkdtemp(join(tmpdir(), "wiki-wt-"));
    const res = await publishWikiSite({
      remoteUrl: remote,
      site: site([{ path: "Home.md", content: "# Home\n" }]),
      message: "publish",
      workdir,
    });
    expect(res.outcome).toBe("published");
    expect(res.branch).toBe("master");

    const check = await mkdtemp(join(tmpdir(), "wiki-check-"));
    await exec("git", ["clone", remote, check], { env: GIT_ENV });
    expect(await readFile(join(check, "Home.md"), "utf8")).toContain("# Home");
  });

  it("returns up-to-date when content is unchanged", async () => {
    const remote = await bareRepo();
    const s = site([{ path: "Home.md", content: "# Home\n" }]);
    await publishWikiSite({ remoteUrl: remote, site: s, message: "one", workdir: await mkdtemp(join(tmpdir(), "w1-")) });
    const res = await publishWikiSite({ remoteUrl: remote, site: s, message: "two", workdir: await mkdtemp(join(tmpdir(), "w2-")) });
    expect(res.outcome).toBe("up-to-date");
  });

  it("clean-mirrors, removing stale pages", async () => {
    const remote = await bareRepo();
    await publishWikiSite({
      remoteUrl: remote,
      site: site([{ path: "Old.md", content: "old" }, { path: "Home.md", content: "h" }]),
      message: "one",
      workdir: await mkdtemp(join(tmpdir(), "wa-")),
    });
    await publishWikiSite({
      remoteUrl: remote,
      site: site([{ path: "Home.md", content: "h2" }]),
      message: "two",
      workdir: await mkdtemp(join(tmpdir(), "wb-")),
    });
    const check = await mkdtemp(join(tmpdir(), "wc-"));
    await exec("git", ["clone", remote, check], { env: GIT_ENV });
    await expect(readFile(join(check, "Old.md"), "utf8")).rejects.toBeTruthy();
  });
});
