import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { Git } from "../git/git.js";
import { OkhError } from "../errors.js";
import type { WikiReverseMode } from "../modules/manifest.js";
import { parseFrontmatter } from "../util/frontmatter.js";
import { WIKI_BOT_EMAIL, WIKI_BOT_NAME, WIKI_CHROME } from "./constants.js";
import { openPr as defaultOpenPr, type OpenPrResult } from "./github.js";
import { toRenderModule } from "./publish.js";
import { renderWikiSite, type SlugSource } from "./renderer.js";
import { selectWikiModules, type SelectedWikiModule } from "./select.js";
import { pathSlug } from "./slug.js";
import { injectToken, parseGitHubRepo, repoBrowseUrl, wikiRemoteUrl } from "./url.js";

export type ReverseOutcome =
  | "disabled"
  | "no-baseline"
  | "up-to-date"
  | "pr-opened"
  | "committed"
  | "committed+pr-opened"
  | "dry-run";

export type ReverseCounts = { added: number; modified: number; deleted: number; renamed: number };

export type ReverseResult = {
  outcome: ReverseOutcome;
  changed: number;
  counts: ReverseCounts;
  prUrl?: string;
  prNumber?: number;
  commit?: string;
};

export type ReverseResolveResult = {
  owner: string;
  repo: string;
  repoUrl: string;
  wikiRemoteUrl: string;
  defaultBranch: string;
};

export type ReverseSyncOptions = {
  token?: string;
  dryRun?: boolean;
  now?: () => Date;
  runId?: string;
  git?: Git;
  resolve?: (repoRoot: string, git: Git) => Promise<ReverseResolveResult>;
  openPr?: (args: Parameters<typeof defaultOpenPr>[0]) => Promise<OpenPrResult>;
  apiBase?: string;
  /** Pre-cloned wiki checkout; when omitted the wiki is cloned from wikiRemoteUrl. */
  wikiWorkdir?: string;
};

type Change = { status: "A" | "M" | "D" | "R"; oldPath?: string; newPath: string };

async function defaultReverseResolve(repoRoot: string, git: Git): Promise<ReverseResolveResult> {
  const remote = await git.defaultRemote(repoRoot);
  const origin = await git.remoteUrl(repoRoot, remote);
  const parsed = parseGitHubRepo(origin);
  if (!parsed) {
    throw new OkhError("INVALID_ARGUMENT", `Origin ${origin} is not a github.com repository.`);
  }
  const defaultBranch = await git.currentBranch(repoRoot).catch(() => "main");
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    repoUrl: repoBrowseUrl(parsed),
    wikiRemoteUrl: wikiRemoteUrl(parsed),
    defaultBranch,
  };
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** Parse `git diff --name-status -M` output into typed changes (chrome dropped). */
function parseChanges(raw: string): Change[] {
  const changes: Change[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    const code = parts[0];
    if (code.startsWith("R") && parts.length >= 3) {
      changes.push({ status: "R", oldPath: parts[1], newPath: parts[2] });
    } else if (code === "A" || code === "M" || code === "D") {
      changes.push({ status: code, newPath: parts[1] });
    }
  }
  return changes.filter(
    (c) => !WIKI_CHROME.has(basename(c.newPath)) && !(c.oldPath && WIKI_CHROME.has(basename(c.oldPath))),
  );
}

/** Wiki page filename (flat, e.g. `telemetry-sources-eed.md`) -> its slug. */
function slugOfWikiPage(wikiPath: string): string {
  return basename(wikiPath).replace(/\.md$/i, "");
}

/** Drop a defensive legacy "generated" banner if a wiki page still carries one. */
function stripLegacyBanner(body: string): string {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  if (i < lines.length && /^>\s*📘/.test(lines[i])) {
    lines.splice(0, i + 1);
    while (lines.length && lines[0].trim() === "") lines.shift();
    return lines.join("\n");
  }
  return body;
}

/** Rewrite bare wiki slug links back to source-relative `.md` paths within the module. */
function unrewriteLinks(body: string, destDir: string, slugToRel: Map<string, string>): string {
  return body.replace(/(\]\()([^)]+)(\))/g, (whole, open, rawTarget, close) => {
    const target = rawTarget.trim();
    if (/^[a-z]+:/i.test(target) || target.startsWith("#")) return whole;
    const hash = target.indexOf("#");
    const slug = hash === -1 ? target : target.slice(0, hash);
    const anchor = hash === -1 ? "" : target.slice(hash);
    if (slug.toLowerCase().endsWith(".md") || slug === "") return whole;
    const sourceRel = slugToRel.get(slug);
    if (!sourceRel) return whole;
    let rel = posix.relative(destDir === "" ? "." : destDir, sourceRel);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return `${open}${rel}${anchor}${close}`;
  });
}

async function readMaybe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Transform a wiki page body into source-file content, preserving existing frontmatter. */
async function transformToSource(
  wikiContent: string,
  destAbs: string,
  destRel: string,
  slugToRel: Map<string, string>,
): Promise<string> {
  let body = stripLegacyBanner(wikiContent);
  body = unrewriteLinks(body, posix.dirname(destRel), slugToRel);
  const existing = await readMaybe(destAbs);
  if (existing !== undefined) {
    const parsed = parseFrontmatter(existing);
    const verbatimFm = existing.slice(0, existing.length - parsed.body.length);
    if (verbatimFm.trim().length > 0) return verbatimFm + body;
  }
  return body;
}

type ModuleTarget = {
  selected: SelectedWikiModule;
  /** Wiki slug (within this module) -> module-relative source path, for link back-rewrite. */
  slugToRel: Map<string, string>;
};

export async function reverseSyncWiki(
  repoRoot: string,
  opts: ReverseSyncOptions = {},
): Promise<ReverseResult> {
  const git = opts.git ?? new Git();
  const resolve = opts.resolve ?? defaultReverseResolve;
  const openPr = opts.openPr ?? defaultOpenPr;
  const zero: ReverseCounts = { added: 0, modified: 0, deleted: 0, renamed: 0 };

  const selected = await selectWikiModules(repoRoot);
  if (selected.every((s) => s.reverseMode === "off")) {
    return { outcome: "disabled", changed: 0, counts: zero };
  }
  const info = await resolve(repoRoot, git);

  // Render all selected modules to map every wiki slug -> its source module + path.
  const modules = await Promise.all(selected.map(toRenderModule));
  const site = renderWikiSite({
    modules,
    context: {
      owner: info.owner,
      repo: info.repo,
      commit: "0".repeat(40),
      timestamp: new Date(0).toISOString(),
      repoUrl: info.repoUrl,
      title: info.repo,
    },
  });
  const slugToSource = site.slugToSource;

  const byName = new Map<string, ModuleTarget>();
  for (const sel of selected) byName.set(sel.name, { selected: sel, slugToRel: new Map() });
  for (const [slug, src] of slugToSource) byName.get(src.module)?.slugToRel.set(slug, src.sourceRel);

  // For attributing brand-new wiki pages (no existing source) to a module, match
  // the longest module-slug prefix. Longer slugs first so `a-b` beats `a`.
  const moduleSlugs = selected
    .map((sel) => ({ name: sel.name, slug: pathSlug(sel.name) }))
    .sort((x, y) => y.slug.length - x.slug.length);

  // Clone the wiki and find the last bot-authored commit as the diff base.
  const wikiDir = opts.wikiWorkdir ?? (await mkdtemp(join(tmpdir(), "okh-wiki-rev-")));
  if (!opts.wikiWorkdir) {
    await git.clone(injectToken(info.wikiRemoteUrl, opts.token), wikiDir);
  }
  const base = await git.logLastCommitBy(wikiDir, WIKI_BOT_EMAIL);
  if (!base) return { outcome: "no-baseline", changed: 0, counts: zero };

  const changes = parseChanges(await git.nameStatus(wikiDir, `${base}..HEAD`));
  if (changes.length === 0) return { outcome: "up-to-date", changed: 0, counts: zero };

  const countsByMode = new Map<WikiReverseMode, ReverseCounts>([
    ["direct", { ...zero }],
    ["pr", { ...zero }],
    ["off", { ...zero }],
  ]);
  /** Repo-relative paths touched, grouped by the owning module's reverse mode. */
  const touchedByMode = new Map<WikiReverseMode, string[]>([
    ["direct", []],
    ["pr", []],
    ["off", []],
  ]);

  const resolveSlug = (slug: string): { target: ModuleTarget; destRel: string } | undefined => {
    const src: SlugSource | undefined = slugToSource.get(slug);
    if (src) {
      const target = byName.get(src.module);
      return target ? { target, destRel: src.sourceRel } : undefined;
    }
    // Brand-new page: attribute to the module whose slug is the longest prefix and
    // land it flat at that module's root (the slug->path map is not reversible).
    for (const m of moduleSlugs) {
      if (slug === m.slug || slug.startsWith(`${m.slug}-`)) {
        const target = byName.get(m.name);
        if (!target) continue;
        const remainder = slug === m.slug ? m.slug : slug.slice(m.slug.length + 1);
        return { target, destRel: `${remainder}.md` };
      }
    }
    return undefined;
  };

  const applyUpsert = async (wikiPath: string, target: ModuleTarget, destRel: string): Promise<void> => {
    const destAbs = join(target.selected.moduleRoot, destRel);
    const wikiContent = await readFile(join(wikiDir, wikiPath), "utf8");
    const content = await transformToSource(wikiContent, destAbs, destRel, target.slugToRel);
    await mkdir(dirname(destAbs), { recursive: true });
    await writeFile(destAbs, content, "utf8");
    touchedByMode.get(target.selected.reverseMode)!.push(join(target.selected.name, destRel));
  };

  const applyDelete = async (target: ModuleTarget, destRel: string): Promise<void> => {
    const destAbs = join(target.selected.moduleRoot, destRel);
    if ((await readMaybe(destAbs)) !== undefined) {
      await rm(destAbs, { force: true });
      touchedByMode.get(target.selected.reverseMode)!.push(join(target.selected.name, destRel));
    }
  };

  for (const change of changes) {
    if (change.status === "A" || change.status === "M") {
      const r = resolveSlug(slugOfWikiPage(change.newPath));
      if (!r) continue; // unknown slug (e.g. Home or a new page for no module) — skip
      await applyUpsert(change.newPath, r.target, r.destRel);
      const c = countsByMode.get(r.target.selected.reverseMode)!;
      if (change.status === "A") c.added += 1;
      else c.modified += 1;
    } else if (change.status === "D") {
      const r = resolveSlug(slugOfWikiPage(change.newPath));
      if (!r) continue;
      await applyDelete(r.target, r.destRel);
      countsByMode.get(r.target.selected.reverseMode)!.deleted += 1;
    } else {
      const oldR = resolveSlug(slugOfWikiPage(change.oldPath!));
      const newR = resolveSlug(slugOfWikiPage(change.newPath));
      if (!newR) continue;
      if (oldR && (oldR.target !== newR.target || oldR.destRel !== newR.destRel)) {
        await applyDelete(oldR.target, oldR.destRel);
      }
      await applyUpsert(change.newPath, newR.target, newR.destRel);
      countsByMode.get(newR.target.selected.reverseMode)!.renamed += 1;
    }
  }

  const directPaths = touchedByMode.get("direct")!;
  const prPaths = touchedByMode.get("pr")!;
  const directCounts = countsByMode.get("direct")!;
  const prCounts = countsByMode.get("pr")!;
  // Report only what actually lands (direct + pr); off-mode edits are dropped.
  const counts = sumCounts(directCounts, prCounts);
  const landed = directPaths.length + prPaths.length;

  if (landed === 0) {
    // Every change fell into an off-mode module (or mapped to nothing).
    return { outcome: "disabled", changed: 0, counts };
  }

  if (opts.dryRun) {
    return { outcome: "dry-run", changed: landed, counts };
  }

  const pushUrl = injectToken(info.repoUrl, opts.token);
  let committedDirect = false;
  let prResult: OpenPrResult | undefined;
  let lastCommit: string | undefined;

  // Land direct-mode edits first so any PR branches off the updated default branch.
  if (directPaths.length > 0) {
    await git.stagePaths(repoRoot, directPaths);
    if (await git.hasStagedChanges(repoRoot)) {
      const message = commitMessage(directPaths.length);
      await git.commitAs(repoRoot, message, WIKI_BOT_NAME, WIKI_BOT_EMAIL);
      lastCommit = await git.currentCommit(repoRoot);
      try {
        await git.pushUrl(repoRoot, pushUrl, `HEAD:refs/heads/${info.defaultBranch}`);
      } catch (err) {
        throw new OkhError(
          "GIT_ERROR",
          `Failed to push wiki edits to ${info.defaultBranch}. Another commit may have landed first; re-run to retry.\n${redact((err as Error).message, opts.token)}`,
        );
      }
      committedDirect = true;
    }
  }

  // Gather all pr-mode edits into a single combined PR.
  if (prPaths.length > 0) {
    const stamp = opts.runId ?? (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const branch = `okh/wiki-sync/${stamp}`;
    await git.createBranch(repoRoot, branch);
    await git.stagePaths(repoRoot, prPaths);
    if (await git.hasStagedChanges(repoRoot)) {
      const message = commitMessage(prPaths.length);
      await git.commitAs(repoRoot, message, WIKI_BOT_NAME, WIKI_BOT_EMAIL);
      lastCommit = await git.currentCommit(repoRoot);
      await git.pushUrl(repoRoot, pushUrl, `HEAD:refs/heads/${branch}`);
      prResult = await openPr({
        owner: info.owner,
        repo: info.repo,
        token: opts.token ?? "",
        head: branch,
        base: info.defaultBranch,
        title: message,
        body: prBody(prCounts, prPaths),
        apiBase: opts.apiBase,
      });
    }
  }

  const outcome: ReverseOutcome =
    committedDirect && prResult ? "committed+pr-opened" : prResult ? "pr-opened" : "committed";
  return {
    outcome,
    changed: landed,
    counts,
    commit: lastCommit,
    prUrl: prResult?.url,
    prNumber: prResult?.number,
  };
}

function commitMessage(n: number): string {
  return `Sync wiki edits (${n} page${n === 1 ? "" : "s"})`;
}

function sumCounts(a: ReverseCounts, b: ReverseCounts): ReverseCounts {
  return {
    added: a.added + b.added,
    modified: a.modified + b.modified,
    deleted: a.deleted + b.deleted,
    renamed: a.renamed + b.renamed,
  };
}

function redact(message: string, token?: string): string {
  return token ? message.split(token).join("***") : message;
}

function prBody(counts: ReverseCounts, touched: string[]): string {
  const lines = [
    "Automated sync of human wiki edits back into the source modules.",
    "",
    `- Added: ${counts.added}`,
    `- Modified: ${counts.modified}`,
    `- Deleted: ${counts.deleted}`,
    `- Renamed: ${counts.renamed}`,
    "",
    "### Files",
    ...touched.map((p) => `- \`${p}\``),
  ];
  return lines.join("\n") + "\n";
}
