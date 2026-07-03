import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/exec.js";
import type { OkhPaths } from "../src/config.js";

/** Deterministic git identity + isolation for tests. */
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "OKH Test",
  GIT_AUTHOR_EMAIL: "okh@example.com",
  GIT_COMMITTER_NAME: "OKH Test",
  GIT_COMMITTER_EMAIL: "okh@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/** A runner bound to the test git identity, injectable into Git/PackService. */
export const testRun: typeof run = (command, args, options = {}) =>
  run(command, args, { ...options, env: { ...GIT_ENV, ...options.env } });

export async function makeTempDir(prefix = "okh-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export function makePaths(home: string): OkhPaths {
  return {
    home,
    containersDir: join(home, "containers"),
    registryFile: join(home, "registry.json"),
  };
}

/** Write a `.okh/okh.yaml` manifest string into a container root. */
export async function writeManifest(containerRoot: string, yaml: string): Promise<void> {
  await mkdir(join(containerRoot, ".okh"), { recursive: true });
  await writeFile(join(containerRoot, ".okh", "okh.yaml"), yaml, "utf8");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, env: GIT_ENV });
  return stdout;
}

/**
 * Create a bare origin repo seeded with an initial commit on `main` containing
 * the given files. Returns the bare repo path (usable as a clone URL).
 */
export async function makeOrigin(files: Record<string, string> = { "README.md": "# origin\n" }): Promise<string> {
  const root = await makeTempDir("okh-origin-");
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  await run("git", ["init", "--bare", "-b", "main", bare], { env: GIT_ENV });
  await run("git", ["clone", bare, seed], { env: GIT_ENV });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(seed, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-m", "seed"]);
  await git(seed, ["push", "origin", "main"]);
  return bare;
}

/** Add a new commit to a bare origin's main branch (used to test pull). */
export async function pushToOrigin(bare: string, rel: string, content: string): Promise<void> {
  const seed = await makeTempDir("okh-push-");
  await run("git", ["clone", bare, seed], { env: GIT_ENV });
  const full = join(seed, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-m", `add ${rel}`]);
  await git(seed, ["push", "origin", "main"]);
  await rm(seed, { recursive: true, force: true });
}
