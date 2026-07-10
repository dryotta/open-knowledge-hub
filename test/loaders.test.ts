import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { knowledgeLoader } from "../src/modules/loaders/knowledge.js";
import { skillsLoader } from "../src/modules/loaders/skills.js";
import { toolsLoader } from "../src/modules/loaders/tools.js";
import { memoryLoader } from "../src/modules/loaders/memory.js";
import { projectLoader } from "../src/modules/loaders/project.js";
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

  it("scaffold does not overwrite an existing index.md", async () => {
    const root = await tmp();
    await write(root, "index.md", "# Existing\n");
    await expect(llmwikiLoader.scaffold!(root)).rejects.toMatchObject({ code: "EEXIST" });
  });
});

describe("skills loader", () => {
  it("enumerates skill folders via SKILL.md frontmatter", async () => {
    const root = await tmp();
    await write(root, "debugging/SKILL.md", "---\nname: Debugging\ndescription: Find bugs\n---\nbody");
    await write(root, "no-skill/notes.md", "ignored");

    const items = await skillsLoader.enumerate(root);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      path: "debugging/SKILL.md",
      title: "Debugging",
      description: "Find bugs",
      type: "skill",
    });
  });

  it("overview lists skills or says none", async () => {
    const root = await tmp();
    expect(await skillsLoader.overview(root)).toContain("No skills");
    await write(root, "x/SKILL.md", "---\nname: X\n---\n");
    expect(await skillsLoader.overview(root)).toContain("**X**");
  });
});

describe("tools loader", () => {
  it("enumerates tool folders via README.md (title from heading, desc from first line)", async () => {
    const root = await tmp();
    await write(root, "csv2json/README.md", "# CSV to JSON\n\nConvert CSV files to JSON.\n");
    await write(root, "csv2json/run.py", "print('x')\n");

    const items = await toolsLoader.enumerate(root);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      path: "csv2json/README.md",
      title: "CSV to JSON",
      description: "Convert CSV files to JSON.",
      type: "tool",
    });
  });

  it("skips subsequent markdown headings when choosing README description", async () => {
    const root = await tmp();
    await write(root, "reporter/README.md", "# Reporter\n\n## Usage\n\nGenerates reports.\n");
    const items = await toolsLoader.enumerate(root);
    expect(items[0]).toMatchObject({ title: "Reporter", description: "Generates reports." });
  });

  it("falls back to the folder name when README has no heading", async () => {
    const root = await tmp();
    await write(root, "widget/README.md", "Does widget things.\n");
    const items = await toolsLoader.enumerate(root);
    expect(items[0]).toMatchObject({ title: "widget", description: "Does widget things." });
  });
});

describe("memory/project loaders (thin file listing)", () => {
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

  it("project loader tags items as project", async () => {
    const root = await tmp();
    await write(root, "spec.md", "x");
    const items = await projectLoader.enumerate(root);
    expect(items[0]).toMatchObject({ path: "spec.md", type: "project" });
  });
});

describe("getLoader dispatch", () => {
  it("returns a loader for every module type", () => {
    for (const t of ["knowledge", "skills", "tools", "memory", "project", "llmwiki"] as const) {
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

  it("falls back to a file-listing loader for a custom type", async () => {
    const loader = getLoader("recipes");
    const overview = await loader.overview("/does/not/exist");
    expect(typeof overview).toBe("string");
  });
});
