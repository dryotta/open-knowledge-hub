import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModuleSkills, mergeSkills, MODULE_SKILL_ROOTS, type Skill } from "../src/modules/skills.js";
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
});

describe("vendored skills", () => {
  it("lists knowledge and memory vendored skills", async () => {
    expect((await vendoredSkills("knowledge")).map((s) => s.name)).toContain("learn");
    expect((await vendoredSkills("memory")).map((s) => s.name).sort()).toEqual(["reflect", "remember"]);
    expect(await vendoredSkills("recipes")).toEqual([]);
  });
});
