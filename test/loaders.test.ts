import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { knowledgeLoader } from "../src/modules/loaders/knowledge.js";
import { skillsLoader } from "../src/modules/loaders/skills.js";
import { memoryLoader } from "../src/modules/loaders/memory.js";
import { llmwikiLoader } from "../src/modules/loaders/llmwiki.js";
import { getLoader } from "../src/modules/registry.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const d = await makeTempDir();
  cleanups.push(d);
  return d;
}

async function write(root: string, rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content, "utf8");
}

describe("knowledge loader", () => {
  it("enumerates concept docs (excluding index.md/log.md) with frontmatter metadata", async () => {
    const root = await tmp();
    await write(root, "index.md", "# idx\n");
    await write(root, "log.md", "# log\n");
    await write(root, "auth.md", "---\ntitle: Auth\ndescription: Login flow\ntype: Flow\n---\nbody");
    await write(root, "sub/db.md", "---\ntitle: DB\n---\nbody");

    const items = await knowledgeLoader.enumerate(root);

    expect(items.map((i) => i.path).sort()).toEqual(["auth.md", "sub/db.md"]);
    const auth = items.find((i) => i.path === "auth.md")!;
    expect(auth).toMatchObject({ title: "Auth", description: "Login flow", type: "Flow" });
    const db = items.find((i) => i.path === "sub/db.md")!;
    expect(db.type).toBe("concept");
  });

  it("overview returns index.md when present, else a generated listing", async () => {
    const root = await tmp();
    await write(root, "index.md", "# My Index\n");
    expect(await knowledgeLoader.overview(root)).toContain("# My Index");

    const root2 = await tmp();
    await write(root2, "auth.md", "---\ntitle: Auth\n---\n");
    const ov = await knowledgeLoader.overview(root2);
    expect(ov).toContain("generated index");
    expect(ov).toContain("Auth");
  });

  it("scaffold writes an OKF index.md skeleton", async () => {
    const root = await tmp();
    await knowledgeLoader.scaffold!(root);
    const ov = await knowledgeLoader.overview(root);
    expect(ov).toContain("okf_version");
  });

  it("scaffold does not overwrite an existing index.md", async () => {
    const root = await tmp();
    await write(root, "index.md", "# Existing\n");
    await expect(knowledgeLoader.scaffold!(root)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await knowledgeLoader.overview(root)).toBe("# Existing\n");
  });

  it("propagates read errors for an existing index.md path", async () => {
    const root = await tmp();
    await mkdir(join(root, "index.md"), { recursive: true });
    await expect(knowledgeLoader.overview(root)).rejects.toBeTruthy();
  });
});

describe("llmwiki loader", () => {
  it("enumerates OKF pages (excluding index.md/log.md), defaulting type to page", async () => {
    const root = await tmp();
    await write(root, "index.md", "# idx\n");
    await write(root, "log.md", "# log\n");
    await write(root, "concepts/attn.md", "---\ntitle: Attention\ndescription: attn\ntype: concept\n---\nbody");
    await write(root, "notes/misc.md", "no frontmatter");

    const items = await llmwikiLoader.enumerate(root);

    expect(items.map((i) => i.path).sort()).toEqual(["concepts/attn.md", "notes/misc.md"]);
    expect(items.find((i) => i.path === "concepts/attn.md")).toMatchObject({ title: "Attention", type: "concept" });
    expect(items.find((i) => i.path === "notes/misc.md")!.type).toBe("page");
  });

  it("overview returns index.md when present, else a wiki-labeled listing", async () => {
    const root = await tmp();
    await write(root, "index.md", "# My Wiki\n");
    expect(await llmwikiLoader.overview(root)).toContain("# My Wiki");

    const root2 = await tmp();
    await write(root2, "concepts/x.md", "---\ntitle: X\n---\n");
    const ov = await llmwikiLoader.overview(root2);
    expect(ov).toContain("Wiki (generated index)");
    expect(ov).toContain("X");
  });

  it("scaffold writes an index.md skeleton and a log.md seed", async () => {
    const root = await tmp();
    await llmwikiLoader.scaffold!(root);
    const ov = await llmwikiLoader.overview(root);
    expect(ov).toContain("okf_version");
    expect(ov).toContain("## Scope");
    const log = await import("node:fs/promises").then((m) => m.readFile(join(root, "log.md"), "utf8"));
    expect(log).toContain("Update Log");
  });

  it("scaffolded index does not create a dangling example link", async () => {
    const root = await tmp();
    await llmwikiLoader.scaffold!(root);

    const h = await llmwikiLoader.health!(root);

    expect(h.danglingLinks).toEqual([]);
  });

  it("scaffold does not overwrite an existing index.md", async () => {
    const root = await tmp();
    await write(root, "index.md", "# Existing\n");
    await expect(llmwikiLoader.scaffold!(root)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("health reports orphans, dangling links, uncataloged pages, and missing type", async () => {
    const root = await tmp();
    await write(root, "index.md", "---\nokf_version: \"0.1\"\n---\n# Wiki\n## Catalog\n* [Attention](/concepts/attention.md) - attn\n");
    await write(root, "log.md", "# Update Log\n");
    await write(root, "concepts/attention.md", "---\ntype: concept\ntitle: Attention\n---\nSee [Transformer](/entities/transformer.md) and [Missing](/concepts/missing.md).\n");
    await write(root, "entities/transformer.md", "---\ntype: entity\ntitle: Transformer\n---\nUses [Attention](/concepts/attention.md).\n");
    await write(root, "concepts/orphan.md", "---\ntitle: Orphan\n---\nNothing links here.\n");

    const h = await llmwikiLoader.health!(root);

    expect(h.orphans).toEqual(["concepts/orphan.md"]);
    expect(h.danglingLinks).toEqual([{ from: "concepts/attention.md", to: "concepts/missing.md" }]);
    expect(h.uncataloged.sort()).toEqual(["concepts/orphan.md", "entities/transformer.md"]);
    expect(h.missingType).toEqual(["concepts/orphan.md"]);
  });

  it("health is clean for a fully connected, cataloged wiki", async () => {
    const root = await tmp();
    await write(root, "index.md", "# Wiki\n## Catalog\n* [A](/a.md)\n* [B](/b.md)\n");
    await write(root, "a.md", "---\ntype: concept\ntitle: A\n---\n[B](/b.md)\n");
    await write(root, "b.md", "---\ntype: concept\ntitle: B\n---\n[A](/a.md)\n");

    const h = await llmwikiLoader.health!(root);

    expect(h).toEqual({ orphans: [], danglingLinks: [], uncataloged: [], missingType: [] });
  });

  it("uses only the root catalog and other content pages for graph health", async () => {
    const root = await tmp();
    await write(root, "index.md", "# Wiki\n");
    await write(root, "log.md", "[A](/concepts/a.md)\n");
    await write(root, "concepts/index.md", "[A](/concepts/a.md)\n");
    await write(root, "concepts/a.md", "---\ntype: concept\ntitle: A\n---\n[A](/concepts/a.md)\n");

    const h = await llmwikiLoader.health!(root);

    expect(h.uncataloged).toEqual(["concepts/a.md"]);
    expect(h.orphans).toEqual(["concepts/a.md"]);
  });
});

describe("skills loader", () => {
  it("recursively enumerates skill leaves via SKILL.md frontmatter", async () => {
    const root = await tmp();
    await write(root, "engineering/testing/debugging/SKILL.md", "---\nname: Debugging\ndescription: Find bugs\n---\nbody");
    await write(root, "engineering/testing/debugging/resources/child/SKILL.md", "---\nname: Hidden\n---\nignored");
    await write(root, "no-skill/notes.md", "ignored");

    const items = await skillsLoader.enumerate(root);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      path: "engineering/testing/debugging/SKILL.md",
      title: "Debugging",
      description: "Find bugs",
      type: "skill",
    });
  });

  it("overview returns index.md when present, else a generated recursive listing", async () => {
    const root = await tmp();
    expect(await skillsLoader.overview(root)).toContain("Empty skills module");
    await write(root, "area/x/SKILL.md", "---\nname: X\n---\n");
    expect(await skillsLoader.overview(root)).toContain("area/x/SKILL.md");
    await write(root, "index.md", "# Team skills\n\n## Structure\n");
    expect(await skillsLoader.overview(root)).toContain("# Team skills");
  });

  it("scaffolds a skills index without overwriting an existing one", async () => {
    const root = await tmp();
    await skillsLoader.scaffold!(root);
    expect(await readFile(join(root, "index.md"), "utf8")).toContain("## Structure");
    expect(skillsLoader.requiredFiles).toContain("index.md");
    await expect(skillsLoader.scaffold!(root)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("propagates read errors for an existing index.md path", async () => {
    const root = await tmp();
    await mkdir(join(root, "index.md"), { recursive: true });
    await expect(skillsLoader.overview(root)).rejects.toBeTruthy();
  });
});

describe("memory loader (thin file listing)", () => {
  it("lists files (excluding README.md) and prepends README in overview", async () => {
    const root = await tmp();
    await write(root, "README.md", "How this memory works.");
    await write(root, "2026-07-02.md", "an entry");
    await write(root, "notes.txt", "x");

    const items = await memoryLoader.enumerate(root);

    expect(items.map((i) => i.path).sort()).toEqual(["2026-07-02.md", "notes.txt"]);
    expect(items[0]!.type).toBe("memory");
    const ov = await memoryLoader.overview(root);
    expect(ov).toContain("How this memory works.");
    expect(ov).toContain("2026-07-02.md");
  });

  it("propagates read errors for an existing README.md path", async () => {
    const root = await tmp();
    await mkdir(join(root, "README.md"), { recursive: true });
    await expect(memoryLoader.overview(root)).rejects.toBeTruthy();
  });
});

describe("getLoader dispatch", () => {
  it("returns a loader for every module type", () => {
    for (const t of ["knowledge", "skills", "memory", "llmwiki"] as const) {
      expect(typeof getLoader(t).enumerate).toBe("function");
      expect(typeof getLoader(t).overview).toBe("function");
    }
  });
});

import { isBuiltinType, BUILTIN_MODULE_TYPES } from "../src/modules/types.js";

describe("type registry", () => {
  it("recognises built-in types", () => {
    expect(isBuiltinType("knowledge")).toBe(true);
    expect(isBuiltinType("recipes")).toBe(false);
    expect(BUILTIN_MODULE_TYPES).toContain("memory");
  });

  it("recognises llmwiki as a built-in type", () => {
    expect(isBuiltinType("llmwiki")).toBe(true);
    expect(BUILTIN_MODULE_TYPES).toContain("llmwiki");
  });

  it("treats retired types (tools, project) as custom", () => {
    expect(isBuiltinType("tools")).toBe(false);
    expect(isBuiltinType("project")).toBe(false);
    expect(BUILTIN_MODULE_TYPES).not.toContain("tools");
    expect(BUILTIN_MODULE_TYPES).not.toContain("project");
    for (const t of ["tools", "project"]) {
      expect(typeof getLoader(t).enumerate).toBe("function");
      expect(typeof getLoader(t).overview).toBe("function");
    }
  });

  it("falls back to a file-listing loader for a custom type", async () => {
    const loader = getLoader("recipes");
    const overview = await loader.overview("/does/not/exist");
    expect(typeof overview).toBe("string");
  });

  it("recursively lists nested custom-module files without duplicating skill resources", async () => {
    const root = await tmp();
    await write(root, "README.md", "# Tools\n");
    await write(root, "csv2json/README.md", "# CSV to JSON\n");
    await write(root, ".claude/skills/cook/SKILL.md", "skill body\n");
    await write(root, ".github/workflows/ci.yml", "workflow\n");
    await write(root, ".venv/lib/tool.py", "venv\n");
    await write(root, "venv/lib/tool.py", "venv\n");
    await write(root, "node_modules/pkg/package.json", "{}\n");
    await write(root, "__pycache__/tool.pyc", "cache\n");
    await write(root, "vendor/pkg/generated.js", "generated\n");

    const items = await getLoader("tools").enumerate(root);
    expect(items.map((item) => item.path)).toEqual(["csv2json/README.md"]);
  });
});
