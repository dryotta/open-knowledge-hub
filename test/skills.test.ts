import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverModuleSkills,
  mergeSkills,
  MODULE_SKILL_ROOTS,
  readSkill,
  skillRootsForType,
  validateModuleSkills,
  type Skill,
} from "../src/modules/skills.js";
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

  it("discovers arbitrary-depth groups and stops descending at a skill leaf", async () => {
    const mod = await mkdtemp(join(tmpdir(), "okh-sk-"));
    try {
      await skill(
        mod,
        join(".okh", "skills", "engineering", "testing", "debug"),
        "debug",
        "debug failures",
      );
      await skill(
        mod,
        join(".okh", "skills", "engineering", "testing", "debug", "resources", "hidden"),
        "hidden",
        "must stay a resource",
      );

      const skills = await discoverModuleSkills(mod);

      expect(skills.map((s) => s.name)).toEqual(["debug"]);
      expect(skills[0]!.path).toBe("engineering/testing/debug/SKILL.md");
    } finally {
      await rm(mod, { recursive: true, force: true });
    }
  });

  it("populates the skill's absolute dir", async () => {
    const mod = await mkdtemp(join(tmpdir(), "okh-sk-"));
    try {
      const dir = join(mod, "grill");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        "---\nname: grill\ndescription: d\nresources:\n  - okh://instructions/grilling.md\n---\n\nBody.\n",
      );
      const s = await readSkill(dir, "vendored");
      expect(s?.dir).toBe(dir);
      expect(s?.resourceUris).toEqual(["okh://instructions/grilling.md"]);
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
      await skill(mod, join("platform", "azure", "ado"), "ado", "ADO CLI");
      await skill(mod, join(".okh", "skills", "nested"), "nested", "nested one");
      const rootOnly = await discoverModuleSkills(mod);
      expect(rootOnly.map((s) => s.name)).toEqual(["nested"]); // default roots ignore the module root
      const withRoot = await discoverModuleSkills(mod, skillRootsForType("skills"));
      expect(withRoot.map((s) => s.name).sort()).toEqual(["ado", "nested"]);
      expect(withRoot.find((s) => s.name === "ado")!.source).toBe("module-root");
      expect(withRoot.find((s) => s.name === "ado")!.path).toBe("platform/azure/ado/SKILL.md");
    } finally {
      await rm(mod, { recursive: true, force: true });
    }
  });

  it("reports malformed leaves and duplicate names within one skill root", async () => {
    const mod = await mkdtemp(join(tmpdir(), "okh-sk-"));
    try {
      await skill(mod, join("engineering", "debug"), "debug", "engineering");
      await skill(mod, join("data", "debug"), "debug", "data");
      await mkdir(join(mod, "ops", "broken"), { recursive: true });
      await writeFile(join(mod, "ops", "broken", "SKILL.md"), "# Missing frontmatter\n");
      await writeFile(join(mod, "SKILL.md"), "---\nname: root\n---\n");

      const issues = await validateModuleSkills(mod, [""]);
      const discovered = await discoverModuleSkills(mod, [""]);

      expect(issues.join("\n")).toMatch(/duplicate skill name "debug"/);
      expect(issues.join("\n")).toMatch(/missing non-empty frontmatter name/);
      expect(issues.join("\n")).toMatch(/skill root cannot itself be a skill leaf/);
      expect(discovered.filter((skill) => skill.name === "debug")).toHaveLength(2);
    } finally {
      await rm(mod, { recursive: true, force: true });
    }
  });
});

describe("vendored skills", () => {
  it("lists built-in type skills", async () => {
    expect((await vendoredSkills("knowledge")).map((s) => s.name)).toContain("learn");
    expect((await vendoredSkills("memory")).map((s) => s.name).sort()).toEqual(["reflect", "remember", "todo"]);
    expect((await vendoredSkills("skills")).map((s) => s.name)).toEqual(["initialize"]);
    expect(await vendoredSkills("recipes")).toEqual([]);
  });
});
