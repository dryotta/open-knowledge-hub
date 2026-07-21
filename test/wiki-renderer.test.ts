import { describe, it, expect } from "vitest";
import { renderWikiSite, type RenderInput, type RenderModule } from "../src/wiki/renderer.js";

const baseCtx = {
  owner: "acme",
  repo: "widgets",
  commit: "abcdef1234567890",
  timestamp: "2026-07-20T00:00:00.000Z",
  repoUrl: "https://github.com/acme/widgets",
  title: "Telemetry",
  reverseMode: "pr" as const,
};

function input(mod?: Partial<RenderModule>, ctx?: Partial<typeof baseCtx>): RenderInput {
  return {
    context: { ...baseCtx, ...ctx },
    module: {
      path: "telemetry",
      description: "Telemetry KB",
      indexMarkdown: "---\nokf_version: \"0.1\"\n---\n# Telemetry\n\nSee [eed](./sources/eed.md) and [home](./index.md).",
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
      ...mod,
    },
  };
}

describe("flat concept pages", () => {
  it("emits root-level slug pages, not nested paths", () => {
    const site = renderWikiSite(input());
    const paths = site.pages.map((p) => p.path);
    expect(paths).toContain("sources-eed.md");
    expect(paths).toContain("cross-cutting-id-pivots.md");
    expect(paths).toContain("areas-network.md");
    expect(paths).not.toContain("telemetry/sources/eed.md");
    expect(paths).not.toContain("telemetry/index.md");
  });

  it("concept pages carry a clean body with no banner and stripped frontmatter", () => {
    const site = renderWikiSite(input());
    const eed = site.pages.find((p) => p.path === "sources-eed.md")!;
    expect(eed.content).toBe("# EED\n\nBody.\n");
    expect(eed.content).not.toContain("📘");
    expect(eed.content).not.toContain("do not edit");
    expect(eed.content).not.toContain("title: EED");
  });

  it("sorts pages by path", () => {
    const site = renderWikiSite(input());
    const paths = site.pages.map((p) => p.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });

  it("de-dups slug collisions with a warning", () => {
    const site = renderWikiSite(
      input({
        indexMarkdown: undefined,
        concepts: [
          { sourceRelPath: "a/b.md", title: "AB", rawMarkdown: "x" },
          { sourceRelPath: "a-b.md", title: "AB2", rawMarkdown: "y" },
        ],
      }),
    );
    const slugs = site.pages.map((p) => p.path).filter((p) => p === "a-b.md" || p === "a-b-2.md");
    expect(slugs).toContain("a-b.md");
    expect(slugs).toContain("a-b-2.md");
    expect(site.warnings.some((w) => w.kind === "collision")).toBe(true);
  });
});

describe("Home from index.md", () => {
  it("uses the module index body with rewritten links and stripped frontmatter", () => {
    const site = renderWikiSite(input());
    const home = site.pages.find((p) => p.path === "Home.md")!;
    expect(home.content).toContain("# Telemetry");
    expect(home.content).not.toContain("okf_version");
    expect(home.content).toContain("[eed](sources-eed)");
    expect(home.content).toContain("[home](Home)");
  });

  it("falls back to a grouped list using the wiki title when there is no index.md", () => {
    const site = renderWikiSite(input({ indexMarkdown: undefined }, { title: "Widgets KB" }));
    const home = site.pages.find((p) => p.path === "Home.md")!;
    expect(home.content).toContain("# Widgets KB");
    expect(home.content).toContain("[EED](sources-eed)");
    expect(home.content).toContain("[Network](areas-network)");
  });
});

describe("slug link rewriting", () => {
  it("rewrites relative, parent, and module-root links to bare slugs", () => {
    const site = renderWikiSite(input());
    const idp = site.pages.find((p) => p.path === "cross-cutting-id-pivots.md")!;
    expect(idp.content).toContain("[eed](sources-eed#x)");
    expect(idp.content).toContain("[self](cross-cutting-id-pivots)");
  });

  it("rewrites a bare sibling link", () => {
    const site = renderWikiSite(
      input({
        indexMarkdown: undefined,
        concepts: [
          { sourceRelPath: "sources/eed.md", title: "EED", rawMarkdown: "See [other](other.md)." },
          { sourceRelPath: "sources/other.md", title: "Other", rawMarkdown: "# Other" },
        ],
      }),
    );
    const eed = site.pages.find((p) => p.path === "sources-eed.md")!;
    expect(eed.content).toContain("[other](sources-other)");
  });

  it("leaves external links untouched and warns on dangling .md links", () => {
    const site = renderWikiSite(
      input({
        indexMarkdown: undefined,
        concepts: [
          {
            sourceRelPath: "sources/eed.md",
            title: "EED",
            rawMarkdown: "[ext](https://x.com/a.md) and [gone](./missing.md)",
          },
        ],
      }),
    );
    const eed = site.pages.find((p) => p.path === "sources-eed.md")!;
    expect(eed.content).toContain("[ext](https://x.com/a.md)");
    expect(site.warnings.some((w) => w.kind === "dangling-link")).toBe(true);
  });
});

describe("grouped collapsible sidebar", () => {
  it("emits a Home link and one alphabetical <details open> group per subfolder", () => {
    const site = renderWikiSite(input());
    const side = site.pages.find((p) => p.path === "_Sidebar.md")!;
    expect(side.content).toContain("[🏠 Home](Home)");
    expect(side.content).toContain("<details open><summary><b>Areas</b> (1)</summary>");
    expect(side.content).toContain("<details open><summary><b>Cross-cutting</b> (1)</summary>");
    expect(side.content).toContain("<details open><summary><b>Sources</b> (1)</summary>");
    expect(side.content).toContain("[EED](sources-eed)");
    expect(side.content).toContain("[Network](areas-network)");
    const iAreas = side.content.indexOf("Areas</b>");
    const iCross = side.content.indexOf("Cross-cutting</b>");
    const iSources = side.content.indexOf("Sources</b>");
    expect(iAreas).toBeLessThan(iCross);
    expect(iCross).toBeLessThan(iSources);
  });

  it("lists root-level pages ungrouped before the groups", () => {
    const site = renderWikiSite(
      input({
        indexMarkdown: undefined,
        concepts: [
          { sourceRelPath: "glossary.md", title: "Glossary", rawMarkdown: "# Glossary" },
          { sourceRelPath: "areas/network.md", title: "Network", rawMarkdown: "# Network" },
        ],
      }),
    );
    const side = site.pages.find((p) => p.path === "_Sidebar.md")!;
    const iGlossary = side.content.indexOf("[Glossary](glossary)");
    const iGroup = side.content.indexOf("<details");
    expect(iGlossary).toBeGreaterThan(-1);
    expect(iGlossary).toBeLessThan(iGroup);
  });
});

describe("header from metadata", () => {
  it("shows the title, provenance, and a pr-mode edit invitation", () => {
    const site = renderWikiSite(input());
    const header = site.pages.find((p) => p.path === "_Header.md")!;
    expect(header.content).toContain("# Telemetry");
    expect(header.content).toContain("[`acme/widgets`](https://github.com/acme/widgets)");
    expect(header.content).toContain("module `telemetry`");
    expect(header.content).toContain("open a pull request back to the source");
  });

  it("adapts the invitation for direct mode", () => {
    const site = renderWikiSite(input(undefined, { reverseMode: "direct" }));
    const header = site.pages.find((p) => p.path === "_Header.md")!;
    expect(header.content).toContain("commit back to the source");
  });

  it("omits the edit invitation for off mode", () => {
    const site = renderWikiSite(input(undefined, { reverseMode: "off" }));
    const header = site.pages.find((p) => p.path === "_Header.md")!;
    expect(header.content).toContain("For reference only");
    expect(header.content).not.toContain("Edits here");
  });
});

describe("footer", () => {
  it("records owner/repo, short commit, a tree link and timestamp", () => {
    const site = renderWikiSite(input());
    const footer = site.pages.find((p) => p.path === "_Footer.md")!;
    expect(footer.content).toContain("acme/widgets@abcdef1");
    expect(footer.content).toContain("/tree/abcdef1234567890");
    expect(footer.content).toContain("2026-07-20T00:00:00.000Z");
  });
});

describe("slugToSource map", () => {
  it("maps every concept slug to its source path plus Home->index.md, excluding chrome", () => {
    const site = renderWikiSite(input());
    expect(site.slugToSource.get("Home")).toBe("index.md");
    expect(site.slugToSource.get("sources-eed")).toBe("sources/eed.md");
    expect(site.slugToSource.get("areas-network")).toBe("areas/network.md");
    expect(site.slugToSource.has("_Header")).toBe(false);
    expect(site.slugToSource.has("_Sidebar")).toBe(false);
  });
});

describe("assets", () => {
  it("flattens a referenced asset and rewrites to a bare filename", () => {
    const bytes = Buffer.from("PNGDATA");
    const site = renderWikiSite(
      input({
        indexMarkdown: undefined,
        concepts: [
          {
            sourceRelPath: "sources/eed.md",
            title: "EED",
            rawMarkdown: "![d](../assets/retry.png)\n[missing](../assets/gone.png)",
          },
        ],
        assets: [{ sourceRelPath: "assets/retry.png", bytes }],
      }),
    );
    expect(site.assets.map((a) => a.path)).toContain("assets-retry.png");
    const eed = site.pages.find((p) => p.path === "sources-eed.md")!;
    expect(eed.content).toContain("![d](assets-retry.png)");
    expect(site.warnings.some((w) => w.kind === "dangling-asset")).toBe(true);
  });
});
