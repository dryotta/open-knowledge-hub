import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { folderLoader } from "../src/modules/loaders/folder.js";
import { getLoader } from "../src/modules/registry.js";
import { isBuiltinType } from "../src/modules/types.js";
import { discoverModuleSkills, skillRootsForType, FOLDER_SKILL_ROOTS } from "../src/modules/skills.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await makeTempDir("okh-folder-");
  cleanups.push(d);
  return d;
}
async function write(root: string, rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content, "utf8");
}

describe("folder loader", () => {
  it("is registered as a built-in type", () => {
    expect(isBuiltinType("folder")).toBe(true);
    expect(getLoader("folder")).toBe(folderLoader);
  });

  it("enumerates only top-level files and folders, excluding reserved entries", async () => {
    const root = await tmp();
    await write(root, "AGENTS.md", "# A\n");
    await write(root, "notes.md", "hi");
    await write(root, "data/report.csv", "a,b");
    await write(root, ".agents/skills/x/SKILL.md", "---\nname: x\n---\nbody");
    await write(root, ".github/skills/y/SKILL.md", "---\nname: y\n---\nbody");
    await write(root, "node_modules/pkg/index.js", "");
    await write(root, ".hidden", "");

    const items = await folderLoader.enumerate(root);
    const byPath = Object.fromEntries(items.map((i) => [i.path, i.type]));
    expect(Object.keys(byPath).sort()).toEqual(["data", "notes.md"]);
    expect(byPath["notes.md"]).toBe("file");
    expect(byPath["data"]).toBe("folder");
  });

  it("overview returns AGENTS.md when present, else a placeholder pointing to initialize", async () => {
    const root = await tmp();
    await write(root, "AGENTS.md", "# My Folder Guide\n");
    expect(await folderLoader.overview(root)).toContain("# My Folder Guide");

    const root2 = await tmp();
    const ov = await folderLoader.overview(root2);
    expect(ov).toMatch(/initialize/i);
    expect(ov).not.toContain("My Folder Guide");
  });

  it("has no required files (valid without AGENTS.md)", () => {
    expect(folderLoader.requiredFiles ?? []).toEqual([]);
  });

  it("scaffold writes a starter AGENTS.md and an empty .agents/skills dir", async () => {
    const root = await tmp();
    await folderLoader.scaffold!(root);
    const overview = await folderLoader.overview(root);
    expect(overview.length).toBeGreaterThan(0);
    expect(overview).not.toMatch(/Run the initialize skill/i); // real skeleton, not the placeholder
    const items = await folderLoader.enumerate(root); // .agents is excluded from enumeration
    expect(items.map((i) => i.path)).not.toContain(".agents");
  });
});

describe("folder skill roots", () => {
  it("skillRootsForType('folder') returns the cross-agent roots in precedence order", () => {
    expect(skillRootsForType("folder")).toEqual([
      ".agents/skills",
      ".claude/skills",
      ".github/skills",
    ]);
    expect(FOLDER_SKILL_ROOTS).toEqual([".agents/skills", ".claude/skills", ".github/skills"]);
  });

  it("discovers skills from all three roots, with .agents winning name collisions", async () => {
    const root = await tmp();
    await write(root, ".agents/skills/shared/SKILL.md", "---\nname: shared\ndescription: from agents\n---\nA");
    await write(root, ".claude/skills/shared/SKILL.md", "---\nname: shared\ndescription: from claude\n---\nB");
    await write(root, ".github/skills/only-gh/SKILL.md", "---\nname: only-gh\ndescription: gh\n---\nC");

    const skills = await discoverModuleSkills(root, skillRootsForType("folder"));
    const byName = Object.fromEntries(skills.map((s) => [s.name, s.description]));
    expect(byName["shared"]).toBe("from agents");
    expect(byName["only-gh"]).toBe("gh");
  });

  it("validate surfaces a malformed SKILL.md via the skill-scan machinery", async () => {
    const root = await tmp();
    // A directory named like a skill leaf but with a non-file SKILL.md is malformed.
    await mkdir(join(root, ".agents/skills/broken/SKILL.md"), { recursive: true });
    const issues = await folderLoader.validate!(root);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(" ")).toMatch(/broken/);
  });

  it("validate returns no issues for a clean folder", async () => {
    const root = await tmp();
    await write(root, ".agents/skills/ok/SKILL.md", "---\nname: ok\ndescription: fine\n---\nbody");
    expect(await folderLoader.validate!(root)).toEqual([]);
  });
});
