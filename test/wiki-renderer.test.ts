import { describe, it, expect } from "vitest";
import { renderWikiSite, type RenderInput, type RenderModule } from "../src/wiki/renderer.js";

const baseCtx = {
  owner: "acme",
  repo: "widgets",
  commit: "abcdef1234567890",
  timestamp: "2026-07-20T00:00:00.000Z",
  repoUrl: "https://github.com/acme/widgets",
  title: "widgets",
};

/** telemetry: index.md references eed before network to prove index-driven ordering. */
function telemetry(overrides: Partial<RenderModule> = {}): RenderModule {
  return {
    path: "telemetry",
    title: "Telemetry",
    description: "Telemetry KB",
    indexMarkdown:
      '---\nokf_version: "0.1"\n---\n# Telemetry\n\nStart with [eed](./sources/eed.md), then [network](./areas/network.md).',
    reverseMode: "pr",
    concepts: [
      { sourceRelPath: "sources/eed.md", title: "EED", rawMarkdown: "---\ntitle: EED\n---\n# EED\n\nBody." },
      {
        sourceRelPath: "cross-cutting/id-pivots.md",
        title: "ID pivots",
        rawMarkdown: "# ID pivots\n\nSee [eed](../sources/eed.md#x) and [self](/cross-cutting/id-pivots.md).",
      },
      { sourceRelPath: "areas/network.md", title: "Network", rawMarkdown: "# Network" },
    ],
    assets: [],
    ...overrides,
  };
}

/** playbooks: no index.md, root-level pages only — exercises the generated landing. */
function playbooks(overrides: Partial<RenderModule> = {}): RenderModule {
  return {
    path: "playbooks",
    title: "Playbooks",
    description: "Ops runbooks",
    reverseMode: "direct",
    concepts: [
      { sourceRelPath: "deploy.md", title: "Deploy", rawMarkdown: "# Deploy" },
      { sourceRelPath: "rollback.md", title: "Rollback", rawMarkdown: "# Rollback" },
    ],
    assets: [],
    ...overrides,
  };
}

function input(modules: RenderModule[], ctx?: Partial<typeof baseCtx>): RenderInput {
  return { context: { ...baseCtx, ...ctx }, modules };
}

describe("namespaced concept pages", () => {
  it("prefixes every page slug with its module", () => {
    const site = renderWikiSite(input([telemetry(), playbooks()]));
    const paths = site.pages.map((p) => p.path);
    expect(paths).toContain("telemetry-sources-eed.md");
    expect(paths).toContain("telemetry-areas-network.md");
    expect(paths).toContain("playbooks-deploy.md");
    expect(paths).toContain("telemetry.md"); // module landing
    expect(paths).toContain("playbooks.md");
    expect(paths).not.toContain("sources-eed.md");
  });

  it("emits clean bodies with stripped frontmatter and no banner", () => {
    const site = renderWikiSite(input([telemetry()]));
    const eed = site.pages.find((p) => p.path === "telemetry-sources-eed.md")!;
    expect(eed.content).toBe("# EED\n\nBody.\n");
    expect(eed.content).not.toContain("title: EED");
  });

  it("de-dups slug collisions across modules with a warning", () => {
    const a = playbooks({ path: "a", title: "A", concepts: [{ sourceRelPath: "b.md", title: "B", rawMarkdown: "x" }] });
    const ab = playbooks({ path: "a-b", title: "AB", concepts: [] });
    const site = renderWikiSite(input([a, ab]));
    const paths = site.pages.map((p) => p.path);
    expect(paths).toContain("a-b.md"); // a's concept a/b -> a-b
    expect(paths).toContain("a-b-2.md"); // module a-b collides -> a-b-2
    expect(site.warnings.some((w) => w.kind === "collision")).toBe(true);
  });
});

describe("module landing pages", () => {
  it("renders a module's index.md at its module slug with rewritten links", () => {
    const site = renderWikiSite(input([telemetry()]));
    const landing = site.pages.find((p) => p.path === "telemetry.md")!;
    expect(landing.content).toContain("# Telemetry");
    expect(landing.content).not.toContain("okf_version");
    expect(landing.content).toContain("[eed](telemetry-sources-eed)");
    expect(landing.content).toContain("[network](telemetry-areas-network)");
  });

  it("generates a contents list when a module has no index.md", () => {
    const site = renderWikiSite(input([playbooks()]));
    const landing = site.pages.find((p) => p.path === "playbooks.md")!;
    expect(landing.content).toContain("# Playbooks");
    expect(landing.content).toContain("[Deploy](playbooks-deploy)");
    expect(landing.content).toContain("[Rollback](playbooks-rollback)");
  });
});

describe("generated Home landing", () => {
  it("lists each module with its title, description, and link to its landing", () => {
    const site = renderWikiSite(input([telemetry(), playbooks()]));
    const home = site.pages.find((p) => p.path === "Home.md")!;
    expect(home.content).toContain("# widgets");
    expect(home.content).toContain("**[Telemetry](telemetry)** — Telemetry KB");
    expect(home.content).toContain("**[Playbooks](playbooks)** — Ops runbooks");
    const iT = home.content.indexOf("Telemetry](telemetry)");
    const iP = home.content.indexOf("Playbooks](playbooks)");
    expect(iT).toBeLessThan(iP);
  });
});

describe("sidebar", () => {
  it("emits a Home link then one open <details> per module by default", () => {
    const site = renderWikiSite(input([playbooks(), telemetry()]));
    const side = site.pages.find((p) => p.path === "_Sidebar.md")!;
    expect(side.content).toContain("[🏠 Home](Home)");
    // Every module is open by default (state can't persist across wiki navigation).
    // The module title is the link (no duplicate landing bullet).
    expect(side.content).toContain('<details open><summary><b><a href="playbooks">Playbooks</a></b></summary>');
    expect(side.content).toContain('<details open><summary><b><a href="telemetry">Telemetry</a></b></summary>');
    // The old duplicate landing bullet is gone now that the title links.
    expect(side.content).not.toContain("- [Telemetry](telemetry)");
    // playbooks' root-level pages are listed directly under the module.
    expect(side.content).toContain("- [Deploy](playbooks-deploy)");
    expect(side.content).toContain("- [Rollback](playbooks-rollback)");
  });

  it("lets a module opt out of the open default with wiki-sync-expanded: false", () => {
    const site = renderWikiSite(input([playbooks(), telemetry({ expanded: false })]));
    const side = site.pages.find((p) => p.path === "_Sidebar.md")!;
    // Collapsed form has no ` open` on the module <details>.
    expect(side.content).toContain('<details><summary><b><a href="telemetry">Telemetry</a></b></summary>');
  });

  it("renders each subfolder as an expandable, open-by-default nested <details>", () => {
    const site = renderWikiSite(input([telemetry()]));
    const side = site.pages.find((p) => p.path === "_Sidebar.md")!;
    expect(side.content).toContain("<details open><summary>Sources</summary>");
    expect(side.content).toContain("<details open><summary>Areas</summary>");
    expect(side.content).toContain("<details open><summary>Cross-cutting</summary>");
    expect(side.content).toContain("- [EED](telemetry-sources-eed)");
    // No bold-label headings anymore.
    expect(side.content).not.toContain("**Sources**");
  });

  it("orders a module's groups by first appearance in its index.md, then alphabetical", () => {
    const site = renderWikiSite(input([telemetry()]));
    const side = site.pages.find((p) => p.path === "_Sidebar.md")!;
    const iSources = side.content.indexOf("<summary>Sources</summary>");
    const iAreas = side.content.indexOf("<summary>Areas</summary>");
    const iCross = side.content.indexOf("<summary>Cross-cutting</summary>");
    // index references eed (Sources) before network (Areas); Cross-cutting is unreferenced -> last.
    expect(iSources).toBeGreaterThan(-1);
    expect(iSources).toBeLessThan(iAreas);
    expect(iAreas).toBeLessThan(iCross);
  });
});

describe("link and asset rewriting", () => {
  it("rewrites relative, parent, and module-root links to namespaced slugs", () => {
    const site = renderWikiSite(input([telemetry()]));
    const idp = site.pages.find((p) => p.path === "telemetry-cross-cutting-id-pivots.md")!;
    expect(idp.content).toContain("[eed](telemetry-sources-eed#x)");
    expect(idp.content).toContain("[self](telemetry-cross-cutting-id-pivots)");
  });

  it("flattens referenced assets to namespaced filenames and warns on missing ones", () => {
    const bytes = Buffer.from("PNGDATA");
    const mod = playbooks({
      concepts: [
        { sourceRelPath: "deploy.md", title: "Deploy", rawMarkdown: "![d](./assets/retry.png)\n[missing](./assets/gone.png)" },
      ],
      assets: [{ sourceRelPath: "assets/retry.png", bytes }],
    });
    const site = renderWikiSite(input([mod]));
    expect(site.assets.map((a) => a.path)).toContain("playbooks-assets-retry.png");
    const deploy = site.pages.find((p) => p.path === "playbooks-deploy.md")!;
    expect(deploy.content).toContain("![d](playbooks-assets-retry.png)");
    expect(site.warnings.some((w) => w.kind === "dangling-asset")).toBe(true);
  });
});

describe("header and footer", () => {
  it("header carries generic provenance and a back-sync note", () => {
    const site = renderWikiSite(input([telemetry()]));
    const header = site.pages.find((p) => p.path === "_Header.md")!;
    expect(header.content).toContain("[`acme/widgets`](https://github.com/acme/widgets)");
    expect(header.content).toContain("may sync back to the source");
    expect(header.content).not.toContain("# widgets");
  });

  it("footer records owner/repo, short commit, tree link, and timestamp", () => {
    const site = renderWikiSite(input([telemetry()]));
    const footer = site.pages.find((p) => p.path === "_Footer.md")!;
    expect(footer.content).toContain("acme/widgets@abcdef1");
    expect(footer.content).toContain("/tree/abcdef1234567890");
    expect(footer.content).toContain("2026-07-20T00:00:00.000Z");
  });
});

describe("slugToSource map", () => {
  it("maps every slug to its module + source path, module landing to index.md, excluding chrome/Home", () => {
    const site = renderWikiSite(input([telemetry(), playbooks()]));
    expect(site.slugToSource.get("telemetry")).toEqual({ module: "telemetry", sourceRel: "index.md" });
    expect(site.slugToSource.get("telemetry-sources-eed")).toEqual({ module: "telemetry", sourceRel: "sources/eed.md" });
    expect(site.slugToSource.get("playbooks-deploy")).toEqual({ module: "playbooks", sourceRel: "deploy.md" });
    expect(site.slugToSource.has("Home")).toBe(false);
    expect(site.slugToSource.has("_Header")).toBe(false);
  });
});
