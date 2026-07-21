import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildAndPublishWiki, buildRenderModule } from "../src/wiki/publish.js";
import { saveModuleManifest } from "../src/modules/manifest.js";
import type { WikiReverseMode } from "../src/modules/manifest.js";

const exec = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

type FixtureOpts = { wikiSync?: boolean; reverseMode?: WikiReverseMode; secondSync?: boolean; skillsSync?: boolean };

async function fixtureRepo(opts: FixtureOpts = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "okh-repo-"));
  await exec("git", ["init", "-b", "main", dir], { env: GIT_ENV });

  await mkdir(join(dir, "design"), { recursive: true });
  await saveModuleManifest(join(dir, "design"), {
    type: "knowledge",
    description: "Design docs",
    ...(opts.wikiSync ? { "wiki-sync": true } : {}),
    ...(opts.reverseMode ? { "wiki-sync-reverse-mode": opts.reverseMode } : {}),
  });
  await writeFile(join(dir, "design", "index.md"), "# Design\n\nOverview.");
  await writeFile(join(dir, "design", "retry.md"), "---\ntitle: Retry\n---\n# Retry\n\nBody.");

  await mkdir(join(dir, "skills"), { recursive: true });
  await saveModuleManifest(join(dir, "skills"), {
    type: "skills",
    description: "S",
    ...(opts.skillsSync ? { "wiki-sync": true } : {}),
  });
  await writeFile(join(dir, "skills", "deploy.md"), "# Deploy");

  if (opts.secondSync) {
    await mkdir(join(dir, "playbooks"), { recursive: true });
    await saveModuleManifest(join(dir, "playbooks"), {
      type: "knowledge",
      description: "Playbooks",
      "wiki-sync": true,
    });
    await writeFile(join(dir, "playbooks", "index.md"), "# Playbooks");
  }

  await exec("git", ["add", "-A"], { cwd: dir, env: GIT_ENV });
  await exec("git", ["commit", "-m", "init"], { cwd: dir, env: GIT_ENV });
  return dir;
}

const resolveStub = async () => ({
  owner: "acme",
  repo: "widgets",
  repoUrl: "https://github.com/acme/widgets",
  wikiRemoteUrl: "unused",
  commit: "abcdef1234567",
});

describe("buildAndPublishWiki module selection", () => {
  it("rejects when no module opts in with wiki-sync", async () => {
    const repo = await fixtureRepo();
    await expect(
      buildAndPublishWiki(repo, { dryRun: true, resolve: resolveStub }),
    ).rejects.toThrow(/wiki-sync/);
  });

  it("dry-run renders every opted-in module, of any type", async () => {
    const repo = await fixtureRepo({ wikiSync: true, skillsSync: true, secondSync: true });
    const res = await buildAndPublishWiki(repo, {
      dryRun: true,
      now: () => new Date("2026-07-20T00:00:00Z"),
      resolve: resolveStub,
    });
    expect(res.outcome).toBe("dry-run");
    expect(res.modules).toBe(3); // design, playbooks, skills
    expect(res.wikiUrl).toBe("https://github.com/acme/widgets/wiki");
  });

  it("publishes multiple modules to a bare wiki remote", async () => {
    const repo = await fixtureRepo({ wikiSync: true, secondSync: true });
    const wiki = await mkdtemp(join(tmpdir(), "okh-wiki-"));
    await exec("git", ["init", "--bare", "-b", "master", wiki], { env: GIT_ENV });
    const res = await buildAndPublishWiki(repo, {
      now: () => new Date("2026-07-20T00:00:00Z"),
      resolve: async () => ({ ...(await resolveStub()), wikiRemoteUrl: wiki }),
    });
    expect(res.outcome).toBe("published");
    expect(res.modules).toBe(2);

    // Verify both module landings and a Home page landed on the wiki.
    const check = await mkdtemp(join(tmpdir(), "okh-wiki-check-"));
    await exec("git", ["clone", wiki, check], { env: GIT_ENV });
    const { stdout } = await exec("git", ["-C", check, "ls-files"], { env: GIT_ENV });
    expect(stdout).toContain("Home.md");
    expect(stdout).toContain("design.md");
    expect(stdout).toContain("playbooks.md");
  });
});

describe("buildRenderModule title derivation", () => {
  it("prefers frontmatter title over a generic body H1 for concepts and the module", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okh-mod-"));
    await writeFile(
      join(dir, "index.md"),
      "---\ntitle: Telemetry Knowledge Pack\n---\n# Overview\n\nLanding.",
    );
    // Rich frontmatter title but a generic `# Overview` first H1 in the body.
    await writeFile(
      join(dir, "eed.md"),
      "---\ntitle: EED / NRT SCR (per-leg call quality)\n---\n# Overview\n\nBody.",
    );
    // No frontmatter title: falls back to the body's first H1.
    await writeFile(join(dir, "aria.md"), "# Aria client telemetry\n\nBody.");
    // Neither: falls back to the title-cased filename.
    await writeFile(join(dir, "id-pivots.md"), "Just prose, no heading.");

    const content = await buildRenderModule(dir, "telemetry", "desc");
    expect(content.title).toBe("Telemetry Knowledge Pack");
    const byPath = new Map(content.concepts.map((c) => [c.sourceRelPath, c.title]));
    expect(byPath.get("eed.md")).toBe("EED / NRT SCR (per-leg call quality)");
    expect(byPath.get("aria.md")).toBe("Aria client telemetry");
    expect(byPath.get("id-pivots.md")).toBe("Id Pivots");
  });
});
