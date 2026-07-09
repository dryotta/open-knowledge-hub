import { describe, it, expect } from "vitest";
import { sharedSkills, resolveSharedSkill, skillResourcePaths } from "../src/modules/shared.js";

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
});
