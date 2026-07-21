import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "../git/git.js";
import { OkhError } from "../errors.js";
import { okfEnumerate } from "../modules/loaders/okf.js";
import { walkFiles } from "../modules/fs.js";
import { parseFrontmatter } from "../util/frontmatter.js";
import { WIKI_BOT_EMAIL, WIKI_BOT_NAME } from "./constants.js";
import { selectWikiModule } from "./select.js";
import {
  renderWikiSite,
  type RenderModule,
  type RenderConcept,
  type RenderAsset,
  type RenderWarning,
} from "./renderer.js";
import { publishWikiSite } from "./repo.js";
import { parseGitHubRepo, repoBrowseUrl, wikiRemoteUrl } from "./url.js";

export type WikiPublishOutcome = "published" | "up-to-date" | "dry-run";
export type WikiPublishResult = {
  outcome: WikiPublishOutcome;
  wikiUrl?: string;
  pages: number;
  assets: number;
  warnings: RenderWarning[];
  commit?: string;
};
export type ResolveResult = {
  owner: string;
  repo: string;
  repoUrl: string;
  wikiRemoteUrl: string;
  commit: string;
};
export type BuildAndPublishOptions = {
  token?: string;
  dryRun?: boolean;
  now?: () => Date;
  git?: Git;
  resolve?: (repoRoot: string, git: Git) => Promise<ResolveResult>;
  workdir?: string;
};

async function defaultResolve(repoRoot: string, git: Git): Promise<ResolveResult> {
  const remote = await git.defaultRemote(repoRoot);
  const origin = await git.remoteUrl(repoRoot, remote);
  const parsed = parseGitHubRepo(origin);
  if (!parsed) {
    throw new OkhError("INVALID_ARGUMENT", `Origin ${origin} is not a github.com repository.`);
  }
  const commit = await git.currentCommit(repoRoot);
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    repoUrl: repoBrowseUrl(parsed),
    wikiRemoteUrl: wikiRemoteUrl(parsed),
    commit,
  };
}

export async function buildRenderModule(
  moduleRoot: string,
  name: string,
  description?: string,
): Promise<RenderModule> {
  let indexMarkdown: string | undefined;
  try {
    indexMarkdown = await readFile(join(moduleRoot, "index.md"), "utf8");
  } catch {
    indexMarkdown = undefined;
  }
  const items = await okfEnumerate(moduleRoot, "knowledge");
  const concepts: RenderConcept[] = [];
  for (const item of items) {
    const rawMarkdown = await readFile(join(moduleRoot, item.path), "utf8");
    concepts.push({ sourceRelPath: item.path, title: item.title, rawMarkdown });
  }
  const assets: RenderAsset[] = [];
  const assetPaths = await walkFiles(moduleRoot, (n) => !n.toLowerCase().endsWith(".md"));
  for (const rel of assetPaths) {
    const bytes = await readFile(join(moduleRoot, rel));
    assets.push({ sourceRelPath: rel, bytes });
  }
  return { path: name, description, indexMarkdown, concepts, assets };
}

/** Wiki title: the module index.md's first H1 if present, else the title-cased folder name. */
export function deriveWikiTitle(module: RenderModule): string {
  if (module.indexMarkdown) {
    const body = parseFrontmatter(module.indexMarkdown).body;
    const h1 = body.match(/^#\s+(.+?)\s*$/m);
    if (h1) return h1[1].trim();
  }
  return module.path
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export async function buildAndPublishWiki(
  repoRoot: string,
  opts: BuildAndPublishOptions = {},
): Promise<WikiPublishResult> {
  const git = opts.git ?? new Git();
  const resolve = opts.resolve ?? defaultResolve;
  const info = await resolve(repoRoot, git);

  const selected = await selectWikiModule(repoRoot);
  const moduleModel = await buildRenderModule(
    selected.moduleRoot,
    selected.name,
    selected.manifest.description,
  );
  const title = deriveWikiTitle(moduleModel);

  const timestamp = (opts.now?.() ?? new Date()).toISOString();
  const site = renderWikiSite({
    module: moduleModel,
    context: {
      owner: info.owner,
      repo: info.repo,
      commit: info.commit,
      timestamp,
      repoUrl: info.repoUrl,
      title,
      reverseMode: selected.reverseMode,
    },
  });

  const wikiUrl = `${info.repoUrl}/wiki`;
  if (opts.dryRun) {
    return {
      outcome: "dry-run",
      wikiUrl,
      pages: site.pages.length,
      assets: site.assets.length,
      warnings: site.warnings,
    };
  }

  const workdir = opts.workdir ?? (await mkdtemp(join(tmpdir(), "okh-wiki-wt-")));
  const short = info.commit.slice(0, 7);
  const result = await publishWikiSite({
    remoteUrl: info.wikiRemoteUrl,
    token: opts.token,
    site,
    message: `Publish wiki from ${short}`,
    workdir,
    git,
    botName: WIKI_BOT_NAME,
    botEmail: WIKI_BOT_EMAIL,
  });

  return {
    outcome: result.outcome,
    wikiUrl,
    pages: site.pages.length,
    assets: site.assets.length,
    warnings: site.warnings,
    commit: result.commit,
  };
}
