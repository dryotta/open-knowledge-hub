import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedSkills, resolveSharedSkill, skillResourcePaths } from "../src/modules/shared.js";
import { readSkill } from "../src/modules/skills.js";

describe("shared skills", () => {
  it("lists the bundled shared skills", async () => {
    const names = (await sharedSkills()).map((s) => s.name).sort();
    expect(names).toContain("grilling");
    expect(names).toContain("okf-writer");
  });

  it("resolves a shared skill by name; unknown throws with a list", async () => {
    const grilling = await resolveSharedSkill("grilling");
    expect(grilling.body.length).toBeGreaterThan(0);
    expect(grilling.source).toBe("shared");
    await expect(resolveSharedSkill("nope")).rejects.toThrow(/grilling|okf-writer/);
  });

  it("surfaces okf-writer's OKF-FORMAT.md resource by absolute path", async () => {
    const writer = await resolveSharedSkill("okf-writer");
    const resources = await skillResourcePaths(writer);
    expect(resources.some((p) => p.endsWith("OKF-FORMAT.md"))).toBe(true);
  });

  it("recurses bundled subfolders while excluding SKILL.md, dotfiles, and noise dirs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okh-res-"));
    try {
      await writeFile(join(dir, "SKILL.md"), "---\nname: kusto\ndescription: query kusto\n---\n\nRun the CLI.\n");
      await writeFile(join(dir, "cli.py"), "print('cli')\n");
      await writeFile(join(dir, ".DS_Store"), "junk\n");
      await mkdir(join(dir, "lib"), { recursive: true });
      await writeFile(join(dir, "lib", "client.py"), "print('client')\n");
      await mkdir(join(dir, "__pycache__"), { recursive: true });
      await writeFile(join(dir, "__pycache__", "cli.pyc"), "compiled\n");
      const skill = await readSkill(dir, "local");
      const resources = (await skillResourcePaths(skill!)).map((p) => p.slice(dir.length + 1));
      expect(resources).toEqual(["cli.py", join("lib", "client.py")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
