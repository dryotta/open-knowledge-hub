import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModuleSkills, mergeSkills, MODULE_SKILL_ROOTS, readSkill, skillRootsForType, type Skill } from "../src/modules/skills.js";
import { vendoredSkills } from "../src/modules/vendored.js";

async function skill(root: string, rel: string, name: string, description: string, body = "do it"): Promise<void> {
  await mkdir(join(root, rel), { recursive: true });
  await writeFile(join(root, rel, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

describe("module skills", () => {
  it("discovers skills from .okh/skills and .claude/skills", async () => {
    const mod = await mkdtemp(join(tmpdir(), "okh-sk-"));
    try {
      await skill(mod, join(".okh", "skills", "remember"), "remember", "record a note");
      await skill(mod, join(".claude", "skills", "summarize"), "summarize", "summarize pages");
      const skills = await discoverModuleSkills(mod);
      expect(skills.map((s) => s.name).sort()).toEqual(["remember", "summarize"]);
      expect(skills.find((s) => s.name === "remember")!.body).toContain("do it");
      expect(MODULE_SKILL_ROOTS).toContain(".claude/skills");
    } finally {
      await rm(mod, { recursive: true, force: true });
    }
  });

  it("populates the skill's absolute dir", async () => {
    const mod = await mkdtemp(join(tmpdir(), "okh-sk-"));
    try {
      const dir = join(mod, "grill");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "---\nname: grill\ndescription: d\n---\n\nBody.\n");
      const s = await readSkill(dir, "vendored");
      expect(s?.dir).toBe(dir);
    } finally {
      await rm(mod, { recursive: true, force: true });
    }
  });

  it("module-local skills override vendored by name", () => {
    const vendored: Skill[] = [{ name: "learn", description: "vendored", body: "V", source: "vendored" }];
    const local: Skill[] = [{ name: "learn", description: "local", body: "L", source: ".okh/skills" }];
    const merged = mergeSkills(vendored, local);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.body).toBe("L");
  });

  it("an earlier skill root wins on a name collision (.okh/skills over .claude/skills)", async () => {
    const mod = await mkdtemp(join(tmpdir(), "okh-sk-"));
    try {
      await skill(mod, join(".okh", "skills", "dup"), "dup", "native");
      await skill(mod, join(".claude", "skills", "dup"), "dup", "external");
      const skills = await discoverModuleSkills(mod);
      const dup = skills.filter((s) => s.name === "dup");
      expect(dup).toHaveLength(1);
      expect(dup[0]!.description).toBe("native");
      expect(dup[0]!.source).toBe(".okh/skills");
    } finally {
      await rm(mod, { recursive: true, force: true });
    }
  });

  it("skillRootsForType adds the module root only for the skills type", () => {
    expect(skillRootsForType("skills")).toEqual([...MODULE_SKILL_ROOTS, ""]);
    expect(skillRootsForType("knowledge")).toEqual([...MODULE_SKILL_ROOTS]);
    expect(skillRootsForType("recipes")).toEqual([...MODULE_SKILL_ROOTS]);
  });

  it("discovers module-root skills when the root is included (skills-type layout)", async () => {
    const mod = await mkdtemp(join(tmpdir(), "okh-sk-"));
    try {
      await skill(mod, "ado", "ado", "ADO CLI");
      await skill(mod, join(".okh", "skills", "nested"), "nested", "nested one");
      const rootOnly = await discoverModuleSkills(mod);
      expect(rootOnly.map((s) => s.name)).toEqual(["nested"]); // default roots ignore the module root
      const withRoot = await discoverModuleSkills(mod, skillRootsForType("skills"));
      expect(withRoot.map((s) => s.name).sort()).toEqual(["ado", "nested"]);
      expect(withRoot.find((s) => s.name === "ado")!.source).toBe("module-root");
    } finally {
      await rm(mod, { recursive: true, force: true });
    }
  });

  it("discovers skills nested under multiple layers of subfolders", async () => {
    const mod = await mkdtemp(join(tmpdir(), "okh-sk-"));
    try {
      await skill(mod, join("azure", "pipelines", "deploy"), "deploy", "ship it");
      await skill(mod, join("azure", "repos", "pr"), "pr", "open a pr");
      const skills = await discoverModuleSkills(mod, skillRootsForType("skills"));
      expect(skills.map((s) => s.name).sort()).toEqual(["deploy", "pr"]);
      const deploy = skills.find((s) => s.name === "deploy")!;
      expect(deploy.dir).toBe(join(mod, "azure", "pipelines", "deploy"));
      expect(deploy.source).toBe("module-root");
    } finally {
      await rm(mod, { recursive: true, force: true });
    }
  });

  it("stops at a skill leaf: a nested SKILL.md under a skill is a resource, not a second skill", async () => {
    const mod = await mkdtemp(join(tmpdir(), "okh-sk-"));
    try {
      await skill(mod, "cli", "cli", "a CLI skill");
      await skill(mod, join("cli", "examples", "sample"), "sample", "a bundled example");
      const skills = await discoverModuleSkills(mod, skillRootsForType("skills"));
      expect(skills.map((s) => s.name)).toEqual(["cli"]);
    } finally {
      await rm(mod, { recursive: true, force: true });
    }
  });

  it("skips dot and noise dirs when scanning the module root", async () => {
    const mod = await mkdtemp(join(tmpdir(), "okh-sk-"));
    try {
      await skill(mod, "real", "real", "kept");
      await skill(mod, join("node_modules", "pkg"), "pkg", "vendored noise");
      const skills = await discoverModuleSkills(mod, skillRootsForType("skills"));
      expect(skills.map((s) => s.name)).toEqual(["real"]);
    } finally {
      await rm(mod, { recursive: true, force: true });
    }
  });
});

describe("vendored skills", () => {
  it("lists knowledge and memory vendored skills", async () => {
    expect((await vendoredSkills("knowledge")).map((s) => s.name)).toContain("learn");
    expect((await vendoredSkills("memory")).map((s) => s.name).sort()).toEqual(["reflect", "remember", "todo"]);
    expect((await vendoredSkills("skills")).map((s) => s.name)).toContain("initialize");
    expect(await vendoredSkills("recipes")).toEqual([]);
  });
});
