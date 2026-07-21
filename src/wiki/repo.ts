import { mkdir, rm, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Git } from "../git/git.js";
import { OkhError } from "../errors.js";
import { WIKI_BOT_EMAIL, WIKI_BOT_NAME } from "./constants.js";
import { injectToken } from "./url.js";
import type { WikiSite } from "./renderer.js";

export type PublishOutcome = "published" | "up-to-date";
export type PublishOptions = {
  remoteUrl: string;
  token?: string;
  site: WikiSite;
  message: string;
  workdir: string;
  git?: Git;
  botName?: string;
  botEmail?: string;
};
export type PublishResult = { outcome: PublishOutcome; commit?: string; branch: string };

function redact(message: string, token?: string): string {
  if (!token) return message;
  return message.split(token).join("***");
}

async function wipeExceptGit(dir: string): Promise<void> {
  for (const entry of await readdir(dir)) {
    if (entry === ".git") continue;
    await rm(join(dir, entry), { recursive: true, force: true });
  }
}

export async function publishWikiSite(opts: PublishOptions): Promise<PublishResult> {
  const git = opts.git ?? new Git();
  const tokenUrl = injectToken(opts.remoteUrl, opts.token);
  let branch = "master";
  try {
    try {
      await git.clone(tokenUrl, opts.workdir);
      branch = await git.currentBranch(opts.workdir).catch(() => "master");
    } catch {
      await rm(opts.workdir, { recursive: true, force: true });
      await mkdir(opts.workdir, { recursive: true });
      await git.initWithBranch(opts.workdir, "master");
      branch = "master";
    }

    await wipeExceptGit(opts.workdir);
    for (const page of opts.site.pages) {
      const abs = join(opts.workdir, page.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, page.content, "utf8");
    }
    for (const asset of opts.site.assets) {
      const abs = join(opts.workdir, asset.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, asset.bytes);
    }

    await git.stageAll(opts.workdir);
    if (!(await git.hasStagedChanges(opts.workdir))) {
      return { outcome: "up-to-date", branch };
    }
    await git.commitAs(opts.workdir, opts.message, opts.botName ?? WIKI_BOT_NAME, opts.botEmail ?? WIKI_BOT_EMAIL);
    const commit = await git.currentCommit(opts.workdir);
    try {
      await git.pushUrl(opts.workdir, tokenUrl, `HEAD:refs/heads/${branch}`);
    } catch (pushErr) {
      throw new OkhError(
        "GIT_ERROR",
        `Failed to push to the wiki remote. Ensure the repository's Wikis feature is enabled (Settings → Features → Wikis) and has at least one initial page.\n${redact((pushErr as Error).message, opts.token)}`,
      );
    }
    return { outcome: "published", commit, branch };
  } catch (err) {
    if (err instanceof OkhError) throw err;
    throw new OkhError("GIT_ERROR", redact((err as Error).message, opts.token));
  }
}
