import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { knowledgeLoader } from "../src/modules/loaders/knowledge.js";

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
