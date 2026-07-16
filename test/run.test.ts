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
      /new file[\s\S]{0,100}do not add YAML frontmatter/i,
      /action|commitment|reminder|todo/i,
      "todos",
      /inspect existing labels/i,
      /operation:\s*"create"/i,
      /entrySummary/i,
      /observation/i,
      /labels/i,
      /general/i,
      /apply:\s*true/i,
      /sync/i,
      /\bIDs?\b/i,
      /recurr/i,
      /dependenc/i,
    ]);
    expect(s.body).not.toContain("update_todo");
    // No preview/confirmation flow — apply directly then sync
    expect(s.body).not.toMatch(/omit `apply`/i);
    expect(s.body).not.toMatch(/needsConfirmation/i);
    expect(s.body).not.toMatch(/exact returned preview/i);
    expect(s.body).not.toMatch(/require.*confirmation|await.*confirm|wait.*confirm/i);
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
    // No preview/confirmation flow — apply directly then sync
    expect(s.body).not.toMatch(/omit `apply`/i);
    expect(s.body).not.toMatch(/needsConfirmation/i);
    expect(s.body).not.toMatch(/exact returned preview/i);
    expect(s.body).not.toMatch(/require.*confirmation|await.*confirm|wait.*confirm/i);
  });

  it("resolveSkill keeps reflection proposal-only until application is explicit", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "mem"), { type: "memory", name: "Mem", description: "" });
    const s = await svc.resolveSkill("h", "mem", "reflect");
    expect(s.body).toMatch(/non-mutating by default/i);
    expect(s.body).toMatch(/unless the caller explicitly asks to apply/i);
    expect(s.body).toMatch(/call `sync` immediately after writing/i);
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

  it("skills type exposes tool-skills authored at the module root, and they are runnable", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "cli"), { type: "skills", name: "CLI Tools", description: "" });
    // A tool-skill = a SKILL.md skill that launches a CLI, authored at the module root.
    const skillDir = join(root, "cli", "platform", "azure", "ado");
    await mkdir(join(skillDir, "lib"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: ado\ndescription: Read-only ADO work items via CLI\n---\n\nRun `python -m tools.ado get-work-item`.\n");
    await writeFile(join(skillDir, "cli.py"), "print('ado')\n");
    await writeFile(join(skillDir, "lib", "client.py"), "print('client')\n");

    // Discoverable: the tool description is visible without loading how-to-run.
    const inspected = await svc.inspect("h", "cli");
    if (inspected.kind !== "module") throw new Error("expected module inspect result");
    const listed = inspected.skills.find((s) => s.name === "ado");
    expect(listed?.description).toBe("Read-only ADO work items via CLI");
    expect(listed?.path).toBe("platform/azure/ado/SKILL.md");

    // Runnable: the how-to-run body loads only when the skill is resolved.
    const resolved = await svc.resolveSkill("h", "cli", "ado");
    expect(resolved.body).toMatch(/python -m tools\.ado/);
  });

  it("allows the same skill name in separate skills modules", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "engineering"), { type: "skills", name: "Engineering", description: "" });
    await saveModuleManifest(join(root, "data"), { type: "skills", name: "Data", description: "" });
    await mkdir(join(root, "engineering", "delivery", "deploy"), { recursive: true });
    await mkdir(join(root, "data", "pipelines", "deploy"), { recursive: true });
    await writeFile(join(root, "engineering", "delivery", "deploy", "SKILL.md"), "---\nname: deploy\n---\n\nDeploy the service.\n");
    await writeFile(join(root, "data", "pipelines", "deploy", "SKILL.md"), "---\nname: deploy\n---\n\nDeploy the pipeline.\n");

    expect((await svc.resolveSkill("h", "engineering", "deploy")).body).toContain("service");
    expect((await svc.resolveSkill("h", "data", "deploy")).body).toContain("pipeline");
  });

  it("rejects ambiguous duplicate names within one skills module", async () => {
    const { root, svc } = await setup();
    await saveModuleManifest(join(root, "skills"), { type: "skills", name: "Skills", description: "" });
    await mkdir(join(root, "skills", "engineering", "deploy"), { recursive: true });
    await mkdir(join(root, "skills", "data", "deploy"), { recursive: true });
    await writeFile(join(root, "skills", "engineering", "deploy", "SKILL.md"), "---\nname: deploy\n---\n\nService.\n");
    await writeFile(join(root, "skills", "data", "deploy", "SKILL.md"), "---\nname: deploy\n---\n\nPipeline.\n");

    await expect(svc.resolveSkill("h", "skills", "deploy")).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("shared skills", () => {
  it("resolveSharedSkill returns the grilling body; unknown throws with a list", async () => {
    const { svc } = await setup();
    const s = await svc.resolveSharedSkill("grilling");
    expect(s.body.length).toBeGreaterThan(0);
    expect(s.body).toMatch(/one decision at a time/i);
    expect(s.body).toMatch(/do\s+not\s+bundle\s+separate\s+decisions/i);
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
