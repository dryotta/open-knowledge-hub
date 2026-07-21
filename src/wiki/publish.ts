import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Git } from "../git/git.js";
import { OkhError } from "../errors.js";
import { walkFiles } from "../modules/fs.js";
import { parseFrontmatter } from "../util/frontmatter.js";
import { WIKI_BOT_EMAIL, WIKI_BOT_NAME } from "./constants.js";
import { selectWikiModules, type SelectedWikiModule } from "./select.js";
import {
  renderWikiSite,
  type RenderModule,
  type RenderModuleContent,
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
  modules: number;
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

const firstH1 = (body: string): string | undefined => body.match(/^#\s+(.+?)\s*$/m)?.[1].trim();

const titleFromFilename = (name: string): string =>
  name
    .replace(/\.md$/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

/** Module title: its index.md's first H1 if present, else the title-cased folder name. */
export function deriveModuleTitle(content: Pick<RenderModuleContent, "path" | "indexMarkdown">): string {
  if (content.indexMarkdown) {
    const h1 = firstH1(parseFrontmatter(content.indexMarkdown).body);
    if (h1) return h1;
  }
  return titleFromFilename(content.path);
}

/** Enumerate a module generically: every `.md` becomes a concept (index.md is the landing). */
export async function buildRenderModule(
  moduleRoot: string,
  name: string,
  description?: string,
): Promise<RenderModuleContent> {
  let indexMarkdown: string | undefined;
  try {
    indexMarkdown = await readFile(join(moduleRoot, "index.md"), "utf8");
  } catch {
    indexMarkdown = undefined;
  }

  const mdPaths = await walkFiles(
    moduleRoot,
    (n) => n.toLowerCase().endsWith(".md") && !n.startsWith("_"),
  );
  const concepts: RenderConcept[] = [];
  for (const rel of mdPaths) {
    if (rel.toLowerCase() === "index.md") continue; // module landing, not a concept
    const rawMarkdown = await readFile(join(moduleRoot, rel), "utf8");
    const title = firstH1(parseFrontmatter(rawMarkdown).body) ?? titleFromFilename(basename(rel));
    concepts.push({ sourceRelPath: rel, title, rawMarkdown });
  }

  const assets: RenderAsset[] = [];
  const assetPaths = await walkFiles(moduleRoot, (n) => !n.toLowerCase().endsWith(".md"));
  for (const rel of assetPaths) {
    assets.push({ sourceRelPath: rel, bytes: await readFile(join(moduleRoot, rel)) });
  }

  const content: RenderModuleContent = { path: name, description, indexMarkdown, concepts, assets, title: "" };
  content.title = deriveModuleTitle(content);
  return content;
}

/** Combine a selected module's config with its enumerated content for the renderer. */
export async function toRenderModule(selected: SelectedWikiModule): Promise<RenderModule> {
  const content = await buildRenderModule(selected.moduleRoot, selected.name, selected.manifest.description);
  return { ...content, reverseMode: selected.reverseMode, expanded: selected.expanded };
}

export async function buildAndPublishWiki(
  repoRoot: string,
  opts: BuildAndPublishOptions = {},
): Promise<WikiPublishResult> {
  const git = opts.git ?? new Git();
  const resolve = opts.resolve ?? defaultResolve;
  const info = await resolve(repoRoot, git);

  const selected = await selectWikiModules(repoRoot);
  const modules = await Promise.all(selected.map(toRenderModule));

  const timestamp = (opts.now?.() ?? new Date()).toISOString();
  const site = renderWikiSite({
    modules,
    context: {
      owner: info.owner,
      repo: info.repo,
      commit: info.commit,
      timestamp,
      repoUrl: info.repoUrl,
      title: info.repo,
    },
  });

  const wikiUrl = `${info.repoUrl}/wiki`;
  if (opts.dryRun) {
    return {
      outcome: "dry-run",
      wikiUrl,
      modules: modules.length,
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
    modules: modules.length,
    pages: site.pages.length,
    assets: site.assets.length,
    warnings: site.warnings,
    commit: result.commit,
  };
}
