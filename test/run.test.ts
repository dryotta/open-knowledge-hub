import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { resolvePaths } from "../src/config.js";
import { saveModuleManifest } from "../src/modules/manifest.js";
import { saveRegistry } from "../src/registry/registry.js";

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "okh-home-"));
  const root = await mkdtemp(join(tmpdir(), "okh-c-"));
  const paths = resolvePaths({ OKH_HOME: home });
  await saveRegistry(paths, { version: 1, containers: [{ name: "h", backend: "local", localPath: root, sync: "auto", addedAt: new Date().toISOString() }] });
  return { home, root, paths, svc: new ContainerService(paths) };
}

describe("effective skills + resolveSkill", () => {
  it("merges vendored memory skills with module-local skills", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "mem"), { type: "memory", name: "Mem", description: "" });
    await mkdir(join(root, "mem", ".okh", "skills", "purge"), { recursive: true });
    await writeFile(join(root, "mem", ".okh", "skills", "purge", "SKILL.md"), "---\nname: purge\ndescription: drop old notes\n---\n\nPurge.\n");
    const skills = await svc.effectiveSkills("h", "mem");
    expect(skills.map((s) => s.name).sort()).toEqual(["purge", "reflect", "remember"]);
  });

  it("resolveSkill returns the SKILL body; unknown skill throws with a list", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "mem"), { type: "memory", name: "Mem", description: "" });
    const s = await svc.resolveSkill("h", "mem", "remember");
    expect(s.body).toMatch(/append/i);
    await expect(svc.resolveSkill("h", "mem", "nope")).rejects.toThrow(/remember|reflect/);
  });

  it("knowledge type exposes learn + initialize", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "kb"), { type: "knowledge", name: "KB", description: "" });
    const names = (await svc.effectiveSkills("h", "kb")).map((s) => s.name).sort();
    expect(names).toEqual(["initialize", "learn"]);
  });

  it("llmwiki type exposes initialize + lint + write", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "wiki"), { type: "llmwiki", name: "Wiki", description: "" });
    const names = (await svc.effectiveSkills("h", "wiki")).map((s) => s.name).sort();
    expect(names).toEqual(["initialize", "lint", "write"]);
  });

  it("custom module exposes only its module-local skills", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "recipes"), { type: "recipes", name: "Food", description: "" });
    await mkdir(join(root, "recipes", ".claude", "skills", "cook"), { recursive: true });
    await writeFile(join(root, "recipes", ".claude", "skills", "cook", "SKILL.md"), "---\nname: cook\ndescription: cook it\n---\n\nCook.\n");
    const skills = await svc.effectiveSkills("h", "recipes");
    expect(skills.map((s) => s.name)).toEqual(["cook"]);
  });
});

describe("shared skills", () => {
  it("resolveSharedSkill returns the grilling body; unknown throws with a list", async () => {
    const { svc } = await setup();
    const s = await svc.resolveSharedSkill("grilling");
    expect(s.body.length).toBeGreaterThan(0);
    await expect(svc.resolveSharedSkill("nope")).rejects.toThrow(/grilling|okf-writer/);
  });

  it("resolveSharedSkill returns the ingest body; ingest is listed among shared skills", async () => {
    const { svc } = await setup();
    const s = await svc.resolveSharedSkill("ingest");
    expect(s.name).toBe("ingest");
    expect(s.body).toMatch(/route/i);
    expect(s.body).toMatch(/llmwiki/);
    await expect(svc.resolveSharedSkill("nope")).rejects.toThrow(/ingest/);
  });
});

describe("llmwiki skill body contracts", () => {
  it("initialize skill body requires invoking shared grilling and states next-steps is not completion", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "wiki"), { type: "llmwiki", name: "Wiki", description: "" });
    const s = await svc.resolveSkill("h", "wiki", "initialize");
    expect(s.body).toMatch(/must invoke.*grilling/i);
    expect(s.body).toMatch(/next\s+steps.*not completion/is);
  });

  it("write skill body requires shared okf-writer invocation omitting container/module, declared type, and final inspect", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "wiki"), { type: "llmwiki", name: "Wiki", description: "" });
    const s = await svc.resolveSkill("h", "wiki", "write");
    // shared okf-writer invocation omits container/module because it's shared
    expect(s.body).toMatch(/omit.*container.*module|omitting.*container.*module/i);
    // use declared type vocabulary
    expect(s.body).toMatch(/declared.*type/i);
    // final inspect
    expect(s.body).toMatch(/inspect/i);
  });
});
