import { posix } from "node:path";
import { parseFrontmatter } from "../util/frontmatter.js";
import type { WikiReverseMode } from "../modules/manifest.js";
import { pathSlug } from "./slug.js";

export type RenderConcept = { sourceRelPath: string; title: string; rawMarkdown: string };
export type RenderAsset = { sourceRelPath: string; bytes: Buffer };

/** Enumerated content of a single module (title/concepts/assets), sync mode aside. */
export type RenderModuleContent = {
  path: string;
  title: string;
  description?: string;
  indexMarkdown?: string;
  concepts: RenderConcept[];
  assets: RenderAsset[];
};

/** A module as handed to the renderer: its content plus its sidebar/reverse config. */
export type RenderModule = RenderModuleContent & {
  reverseMode: WikiReverseMode;
  /** Sidebar expand state; undefined defaults to open. Set false to start collapsed. */
  expanded?: boolean;
};

export type RenderContextInfo = {
  owner: string;
  repo: string;
  commit: string;
  timestamp: string;
  repoUrl: string;
  /** Overall wiki landing title (the repository name). */
  title: string;
};
export type RenderInput = { modules: RenderModule[]; context: RenderContextInfo };

export type WikiPage = { path: string; content: string };
export type WikiAsset = { path: string; bytes: Buffer };
export type RenderWarning = { kind: "collision" | "dangling-link" | "dangling-asset"; message: string };

/** Where a wiki slug came from: which module, and the module-relative source path. */
export type SlugSource = { module: string; sourceRel: string };
export type WikiSite = {
  pages: WikiPage[];
  assets: WikiAsset[];
  warnings: RenderWarning[];
  /** Wiki slug -> its source module + module-relative path. Chrome/Home excluded. */
  slugToSource: Map<string, SlugSource>;
};

const HOME_SLUG = "Home";
const INDEX_REL = "index.md";

type PageRec = { slug: string; title: string; sourceRel: string };
type ModulePlan = {
  module: RenderModule;
  moduleSlug: string;
  records: PageRec[];
  pageIndex: Map<string, string>; // module-rel path (lowercased) -> slug (index.md -> moduleSlug)
};
type RewriteContext = {
  modulePath: string;
  currentDir: string;
  pageIndex: Map<string, string>;
  assets: RenderAsset[];
};

const stripFrontmatter = (markdown: string): string => parseFrontmatter(markdown).body;
const titleCase = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

function splitAnchor(target: string): [string, string | undefined] {
  const i = target.indexOf("#");
  if (i === -1) return [target, undefined];
  return [target.slice(0, i), target.slice(i + 1)];
}

/** Resolve a link target to a module-relative path. Leading slash = module root. */
function resolveTarget(pathPart: string, currentDir: string): string {
  return pathPart.startsWith("/")
    ? posix.normalize(pathPart.slice(1))
    : posix.normalize(posix.join(currentDir, pathPart));
}

/** Namespaced slug for a module-relative path, e.g. (telemetry, sources/eed.md) -> telemetry-sources-eed. */
function namespacedSlug(modulePath: string, sourceRel: string): string {
  return pathSlug(posix.join(modulePath, sourceRel));
}

/**
 * Parse a module's index.md and return the order in which it references its own
 * pages, so the sidebar/landing can mirror the author's intended sequence.
 * Returns module-rel path (lowercased) -> first-appearance index.
 */
function indexOrder(module: RenderModule): Map<string, number> {
  const order = new Map<string, number>();
  if (!module.indexMarkdown) return order;
  const body = stripFrontmatter(module.indexMarkdown);
  const linkRe = /\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = linkRe.exec(body)) !== null) {
    const target = m[1].trim();
    if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
    const [pathPart] = splitAnchor(target);
    if (!pathPart.toLowerCase().endsWith(".md")) continue;
    const rel = resolveTarget(pathPart, ".").toLowerCase();
    if (!order.has(rel)) order.set(rel, n++);
  }
  return order;
}

/** Assign namespaced slugs to a module's concepts (index.md -> moduleSlug). */
function planModule(module: RenderModule, used: Set<string>, warnings: RenderWarning[]): ModulePlan {
  const claim = (desired: string): string => {
    let slug = desired;
    let n = 1;
    while (used.has(slug.toLowerCase())) {
      n += 1;
      slug = `${desired}-${n}`;
      warnings.push({ kind: "collision", message: `Slug collision for ${desired}; using ${slug}` });
    }
    used.add(slug.toLowerCase());
    return slug;
  };

  const moduleSlug = claim(pathSlug(module.path));
  const pageIndex = new Map<string, string>();
  pageIndex.set(INDEX_REL, moduleSlug);

  const records: PageRec[] = [];
  for (const c of [...module.concepts].sort((a, b) => a.sourceRelPath.localeCompare(b.sourceRelPath))) {
    const slug = claim(namespacedSlug(module.path, c.sourceRelPath));
    pageIndex.set(c.sourceRelPath.toLowerCase(), slug);
    records.push({ slug, title: c.title, sourceRel: c.sourceRelPath });
  }
  return { module, moduleSlug, records, pageIndex };
}

/** Rewrite internal markdown links/assets to namespaced wiki slugs / asset filenames. */
function rewriteBody(
  rawBody: string,
  ctx: RewriteContext,
): { body: string; assets: WikiAsset[]; warnings: RenderWarning[] } {
  const warnings: RenderWarning[] = [];
  const collectedAssets: WikiAsset[] = [];
  const linkRe = /(\]\()([^)]+)(\))/g;

  const body = rawBody.replace(linkRe, (whole, open, rawTarget, close) => {
    const target = rawTarget.trim();
    if (/^[a-z]+:/i.test(target) || target.startsWith("#")) return whole;
    const [pathPart, anchor] = splitAnchor(target);
    if (pathPart === "") return whole;
    const resolved = resolveTarget(pathPart, ctx.currentDir);
    const suffix = anchor ? `#${anchor}` : "";

    if (!pathPart.toLowerCase().endsWith(".md")) {
      const asset = ctx.assets.find((a) => a.sourceRelPath === resolved);
      if (!asset) {
        warnings.push({ kind: "dangling-asset", message: `Missing asset ${target}` });
        return whole;
      }
      const flat = namespacedSlug(ctx.modulePath, asset.sourceRelPath);
      collectedAssets.push({ path: flat, bytes: asset.bytes });
      return `${open}${flat}${suffix}${close}`;
    }

    const slug = ctx.pageIndex.get(resolved.toLowerCase());
    if (!slug) {
      warnings.push({ kind: "dangling-link", message: `Dangling link ${target}` });
      return whole;
    }
    return `${open}${slug}${suffix}${close}`;
  });

  return { body, assets: collectedAssets, warnings };
}

/** Group a module's records by first subfolder, ordered by the module's index.md. */
function orderedGrouping(
  records: PageRec[],
  order: Map<string, number>,
): { root: PageRec[]; groups: { name: string; items: PageRec[] }[] } {
  const key = (r: PageRec): number => order.get(r.sourceRel.toLowerCase()) ?? Number.POSITIVE_INFINITY;
  const cmp = (a: PageRec, b: PageRec): number => key(a) - key(b) || a.title.localeCompare(b.title);

  const root: PageRec[] = [];
  const byFolder = new Map<string, PageRec[]>();
  for (const r of records) {
    const i = r.sourceRel.indexOf("/");
    if (i === -1) {
      root.push(r);
    } else {
      const folder = r.sourceRel.slice(0, i);
      const bucket = byFolder.get(folder) ?? [];
      bucket.push(r);
      byFolder.set(folder, bucket);
    }
  }
  root.sort(cmp);
  const groups = [...byFolder.entries()]
    .map(([name, items]) => ({ name, items: [...items].sort(cmp) }))
    .sort((a, b) => {
      const ak = Math.min(...a.items.map(key));
      const bk = Math.min(...b.items.map(key));
      return ak - bk || a.name.localeCompare(b.name);
    });
  return { root, groups };
}

/** HTML-escape text placed inside <summary>/<a> so titles with & or <> stay valid. */
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One module's block inside the sidebar: an open <details> whose title links to
 *  the module landing, with each subfolder as a nested, open-by-default <details>. */
function sidebarSection(plan: ModulePlan, open: boolean): string[] {
  const { module, moduleSlug, records } = plan;
  const { root, groups } = orderedGrouping(records, indexOrder(module));
  const summary = `<summary><b><a href="${moduleSlug}">${escHtml(module.title)}</a></b></summary>`;
  const lines: string[] = [`<details${open ? " open" : ""}>${summary}`, ""];
  for (const r of root) lines.push(`- [${r.title}](${r.slug})`);
  if (root.length > 0) lines.push("");
  for (const g of groups) {
    lines.push(`<details open><summary>${escHtml(titleCase(g.name))}</summary>`, "");
    for (const r of g.items) lines.push(`- [${r.title}](${r.slug})`);
    lines.push("", "</details>");
  }
  lines.push("</details>", "");
  return lines;
}

function renderSidebar(plans: ModulePlan[]): WikiPage {
  const lines: string[] = ["[🏠 Home](Home)", ""];
  for (const plan of plans) {
    // Modules are open by default; `wiki-sync-expanded: false` opts a module out.
    const open = plan.module.expanded ?? true;
    lines.push(...sidebarSection(plan, open));
  }
  return { path: "_Sidebar.md", content: lines.join("\n").trimEnd() + "\n" };
}

/** Generated landing page: the repo title and one entry per published module. */
function renderHome(plans: ModulePlan[], ctx: RenderContextInfo): WikiPage {
  const lines: string[] = [`# ${ctx.title}`, "", "Modules published to this wiki:", ""];
  for (const plan of plans) {
    const desc = plan.module.description ? ` — ${plan.module.description}` : "";
    lines.push(`- **[${plan.module.title}](${plan.moduleSlug})**${desc}`);
  }
  return { path: "Home.md", content: lines.join("\n").trimEnd() + "\n" };
}

/** A module's landing page: its index.md (rewritten) or a generated contents list. */
function renderModuleLanding(
  plan: ModulePlan,
): { page: WikiPage; assets: WikiAsset[]; warnings: RenderWarning[] } {
  const { module, moduleSlug } = plan;
  if (module.indexMarkdown) {
    const rewritten = rewriteBody(stripFrontmatter(module.indexMarkdown), {
      modulePath: module.path,
      currentDir: ".",
      pageIndex: plan.pageIndex,
      assets: module.assets,
    });
    return {
      page: { path: `${moduleSlug}.md`, content: rewritten.body.trimEnd() + "\n" },
      assets: rewritten.assets,
      warnings: rewritten.warnings,
    };
  }
  const lines: string[] = [`# ${module.title}`, ""];
  if (module.description) lines.push(module.description, "");
  const { root, groups } = orderedGrouping(plan.records, indexOrder(module));
  for (const r of root) lines.push(`- [${r.title}](${r.slug})`);
  if (root.length > 0) lines.push("");
  for (const g of groups) {
    lines.push(`### ${titleCase(g.name)}`, "");
    for (const r of g.items) lines.push(`- [${r.title}](${r.slug})`);
    lines.push("");
  }
  return { page: { path: `${moduleSlug}.md`, content: lines.join("\n").trimEnd() + "\n" }, assets: [], warnings: [] };
}

/** Global `_Header.md`: provenance shared by every page. */
function renderHeader(ctx: RenderContextInfo): WikiPage {
  const line =
    `_Generated from [\`${ctx.owner}/${ctx.repo}\`](${ctx.repoUrl}). ` +
    `Human edits here may sync back to the source._`;
  return { path: "_Header.md", content: line + "\n" };
}

function renderFooter(ctx: RenderContextInfo): WikiPage {
  const content =
    `---\n` +
    `_Generated by [Open Knowledge Hub](https://github.com/dryotta/open-knowledge-hub) from ` +
    `[\`${ctx.owner}/${ctx.repo}@${ctx.commit.slice(0, 7)}\`](${ctx.repoUrl}/tree/${ctx.commit}) on ${ctx.timestamp}._\n`;
  return { path: "_Footer.md", content };
}

function dedupeAssets(assets: WikiAsset[]): WikiAsset[] {
  const seen = new Set<string>();
  const out: WikiAsset[] = [];
  for (const a of assets) {
    if (seen.has(a.path)) continue;
    seen.add(a.path);
    out.push(a);
  }
  return out;
}

export function renderWikiSite(input: RenderInput): WikiSite {
  const { modules, context } = input;
  const used = new Set<string>([HOME_SLUG.toLowerCase()]);
  const warnings: RenderWarning[] = [];
  const plans = modules.map((module) => planModule(module, used, warnings));

  const pages: WikiPage[] = [];
  let assets: WikiAsset[] = [];
  const slugToSource = new Map<string, SlugSource>();

  for (const plan of plans) {
    const { module, moduleSlug } = plan;
    slugToSource.set(moduleSlug, { module: module.path, sourceRel: INDEX_REL });

    // Concept pages.
    const conceptByRel = new Map(module.concepts.map((c) => [c.sourceRelPath, c] as const));
    for (const rec of plan.records) {
      const concept = conceptByRel.get(rec.sourceRel)!;
      const rewritten = rewriteBody(stripFrontmatter(concept.rawMarkdown), {
        modulePath: module.path,
        currentDir: posix.dirname(rec.sourceRel),
        pageIndex: plan.pageIndex,
        assets: module.assets,
      });
      warnings.push(...rewritten.warnings);
      assets.push(...rewritten.assets);
      pages.push({ path: `${rec.slug}.md`, content: rewritten.body.trimEnd() + "\n" });
      slugToSource.set(rec.slug, { module: module.path, sourceRel: rec.sourceRel });
    }

    // Module landing.
    const landing = renderModuleLanding(plan);
    warnings.push(...landing.warnings);
    assets.push(...landing.assets);
    pages.push(landing.page);
  }

  pages.push(renderHome(plans, context));
  pages.push(renderHeader(context));
  pages.push(renderSidebar(plans));
  pages.push(renderFooter(context));

  assets = dedupeAssets(assets);
  pages.sort((a, b) => a.path.localeCompare(b.path));
  assets.sort((a, b) => a.path.localeCompare(b.path));

  return { pages, assets, warnings, slugToSource };
}
