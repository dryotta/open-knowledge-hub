import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { resolvePaths } from "../src/config.js";
import { getLoader } from "../src/modules/registry.js";

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "okh-cm-home-"));
  const containerDir = await mkdtemp(join(tmpdir(), "okh-cm-c-"));
  const paths = resolvePaths({ OKH_HOME: home });
  const svc = new ContainerService(paths);
  return { home, containerDir, paths, svc };
}

describe("custom module type end-to-end", () => {
  it("registers a local container with a custom 'recipes' module and discovers .claude/skills", async () => {
    const { home, containerDir, svc } = await setup();
    try {
      // 1. Add local container
      const addedContainer = await svc.addContainer({ source: containerDir, create: true });
      if (addedContainer.kind !== "applied") throw new Error("expected applied");
      const containerName = addedContainer.entry.name;
      expect(addedContainer.entry.backend.type).toBe("local");

      // 2. Add custom module (type "recipes" is not a builtin)
      const addedModule = await svc.addModule({
        container: containerName,
        path: "recipes",
        type: "recipes",
        name: "Food",
        create: true,
      });
      if (addedModule.kind !== "applied") throw new Error("expected applied");
      const moduleRoot = addedModule.moduleRoot;
      expect(addedModule.entry.type).toBe("recipes");
      expect(addedModule.entry.name).toBe("Food");

      // 3. Write a .claude/skills/cook/SKILL.md into the module folder
      const skillDir = join(moduleRoot, ".claude", "skills", "cook");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: cook\ndescription: How to cook a recipe\n---\n\nFollow the recipe steps carefully.\n",
      );

      // 4. Assert inspect(container, "recipes") shows type and skill
      const inspected = await svc.inspect(containerName, "recipes");
      if (inspected.kind !== "module") throw new Error("expected module inspect result");
      expect(inspected.module.type).toBe("recipes");
      expect(inspected.module.name).toBe("Food");
      const cookSkill = inspected.skills.find((s) => s.name === "cook");
      expect(cookSkill).toBeDefined();
      expect(cookSkill!.description).toBe("How to cook a recipe");

      // 5. Assert resolveSkill returns the skill body
      const resolved = await svc.resolveSkill(containerName, "recipes", "cook");
      expect(resolved.name).toBe("cook");
      expect(resolved.description).toBe("How to cook a recipe");
      expect(resolved.body).toMatch(/Follow the recipe steps carefully/);

      // 6. Assert the custom type uses the file-listing loader
      // Write a plain file into the module to be enumerated
      await writeFile(join(moduleRoot, "pasta.md"), "# Pasta\n\nA classic pasta recipe.\n");

      const loader = getLoader("recipes");
      const overview = await loader.overview(moduleRoot);
      // The overview is a string listing from the generic file-listing loader
      expect(typeof overview).toBe("string");
      expect(overview).toMatch(/pasta\.md/);

      const items = await loader.enumerate(moduleRoot);
      const pastaItem = items.find((i) => i.path === "pasta.md");
      expect(pastaItem).toBeDefined();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(containerDir, { recursive: true, force: true });
    }
  });
});
