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
  await saveRegistry(paths, { version: 2, containers: [{ name: "h", backend: { type: "local", config: {} }, localPath: root, sync: { mode: "auto", config: {} }, addedAt: new Date().toISOString() }] });
  return { home, root, paths, svc: new ContainerService(paths) };
}

function expectTerms(text: string, terms: Array<string | RegExp>): void {
  for (const term of terms) {
    if (typeof term === "string") expect(text).toContain(term);
    else expect(text).toMatch(term);
  }
}

describe("effective skills + resolveSkill", () => {
  it("merges vendored memory skills with module-local skills", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "mem"), { type: "memory", name: "Mem", description: "" });
    await mkdir(join(root, "mem", ".okh", "skills", "purge"), { recursive: true });
    await writeFile(join(root, "mem", ".okh", "skills", "purge", "SKILL.md"), "---\nname: purge\ndescription: drop old notes\n---\n\nPurge.\n");
    const skills = await svc.effectiveSkills("h", "mem");
    expect(skills.map((s) => s.name).sort()).toEqual(["purge", "reflect", "remember", "todo"]);
  });

  it("resolveSkill returns remember guidance for facts and todo-bearing input; unknown skill throws with a list", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "mem"), { type: "memory", name: "Mem", description: "" });
    const s = await svc.resolveSkill("h", "mem", "remember");
    expectTerms(s.body, [
      /append/i,
      /ISO timestamp/i,
      /action|commitment|reminder|todo/i,
      "todos",
      /inspect existing labels/i,
      /operation:\s*"create"/i,
      /entrySummary/i,
      /observation/i,
      /omit `apply`/i,
      /exact returned preview/i,
      /needsConfirmation/i,
      /labels/i,
      /general/i,
      /confirm/i,
      /apply:\s*true/i,
      /sync/i,
      /\bIDs?\b/i,
      /recurr/i,
      /dependenc/i,
    ]);
    expect(s.body).not.toContain("update_todo");
    await expect(svc.resolveSkill("h", "mem", "nope")).rejects.toThrow(/todo/);
  });

  it("resolveSkill returns deterministic todo mutation guidance", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "mem"), { type: "memory", name: "Mem", description: "" });
    const s = await svc.resolveSkill("h", "mem", "todo");
    expectTerms(s.body, [
      /deterministic/i,
      "todos",
      /operation:\s*"list"/i,
      /operation:\s*"update"/i,
      /complete/i,
      /reopen/i,
      /labels/i,
      /due/i,
      /priority/i,
      /omit `apply`/i,
      /exact returned preview/i,
      /needsConfirmation/i,
      /confirm/i,
      /apply:\s*true/i,
      /sync/i,
      /ref/i,
      /\bIDs?\b/i,
      /custom statuses?/i,
      /delete/i,
      /recurr/i,
    ]);
    expect(s.body).not.toContain("update_todo");
    expect(s.body).not.toMatch(/operation:\s*"patch"/i);
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

  it("write skill requires repeated inspect until all health arrays are empty before completion", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "wiki"), { type: "llmwiki", name: "Wiki", description: "" });
    const s = await svc.resolveSkill("h", "wiki", "write");
    // Must require fixing all four health categories
    expect(s.body).toMatch(/orphan/i);
    expect(s.body).toMatch(/dangling/i);
    expect(s.body).toMatch(/uncataloged/i);
    expect(s.body).toMatch(/type/i);
    // Must require repeating inspect until health is fully empty
    expect(s.body).toMatch(/repeat.*inspect|re-?run.*inspect|inspect.*again|inspect.*until/i);
    // Must NOT allow logging remaining health debt as a completion alternative
    expect(s.body).not.toMatch(/remaining.*intentional.*noted|intentional.*noted.*log|or.*intentional/i);
    // Completion must require clean health unconditionally
    expect(s.body).toMatch(/clean/i);
  });
});
