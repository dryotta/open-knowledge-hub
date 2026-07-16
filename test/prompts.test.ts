import { rm } from "node:fs/promises";
import { afterEach, describe, it, expect } from "vitest";
import { ContainerService, type ResolvedContainer, type ResolvedModule } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { buildAddModule, buildAsk, buildContext, buildInstructions, buildOnboard, buildRun } from "../src/prompts/index.js";
import { loadPromptFile } from "../src/prompts/templates.js";
import type { Skill } from "../src/modules/skills.js";
import { makePaths, makeTempDir, testRun } from "./helpers.js";

class FakeGh { async createRepo(){return "x";} async createPr(){return "x";} }
const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("resolveTargets", () => {
  it("resolves module abs paths for a container, and errors on unknown module", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const dir = await makeTempDir(); cleanups.push(dir);
    const service = new ContainerService(makePaths(home), new Git(testRun), new FakeGh() as unknown as Gh);
    await service.addContainer({ source: dir, name: "hub", create: true });
    await service.addModule({ container: "hub", path: "kb", type: "knowledge", name: "KB", create: true });
    const targets = await service.resolveTargets("hub");
    expect(targets).toHaveLength(1);
    expect(targets[0]!.modules[0]!.absPath).toContain("kb");
    await expect(service.resolveTargets("hub", "ghost")).rejects.toBeTruthy();
  });

  it("spans all containers when none is given", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const a = await makeTempDir(); cleanups.push(a);
    const b = await makeTempDir(); cleanups.push(b);
    const service = new ContainerService(makePaths(home), new Git(testRun), new FakeGh() as unknown as Gh);
    await service.addContainer({ source: a, name: "a", create: true });
    await service.addContainer({ source: b, name: "b", create: true });
    expect(await service.resolveTargets()).toHaveLength(2);
  });
});

describe("prompt builders", () => {
  const targets: ResolvedContainer[] = [
    { name: "hub", backend: "local", sync: { mode: "auto", config: {} }, syncActions: [], root: "/c/hub", modules: [
      { type: "knowledge", path: "kb", name: "kb", description: "", absPath: "/c/hub/kb" },
      { type: "memory", path: "mem", name: "mem", description: "", absPath: "/c/hub/mem" },
    ] },
  ];
  it("ask includes the question, the target path, and the ask discipline", async () => {
    const text = await buildAsk(targets, "How does auth work?");
    expect(text).toContain("How does auth work?");
    expect(text).toContain("/c/hub/kb");
    expect(text).toContain('<discipline name="ask">');
    expect(text).toMatch(/correlation is not causation/i);
    expect(text).toMatch(/do not add generic benefits/i);
  });
  it("context uses the context discipline", async () => {
    expect(await buildContext(targets, "Ship the feature")).toMatch(/working set/i);
  });
  it("context discipline explicitly omits irrelevant/rejected candidates from the final brief", async () => {
    const text = await buildContext(targets, "Debug CSV import");
    // The discipline must explicitly forbid listing rejected candidates, not just omit them silently
    expect(text).toMatch(/omit.{0,120}(irrelevant|rejected)/is);
  });
  it("onboard includes staged guidance, the wake phrase, and config routing", async () => {
    const text = await buildOnboard(targets, { wakePhrase: "sam" });
    expect(text).toContain("sam");
    expect(text).toMatch(/Stage 1/);
    expect(text).toContain("config { set: { wakePhrase");
    expect(text).not.toContain("onboard { wakePhrase");
    // Confirmation is only for setup (folders/containers/modules), not ordinary sync
    expect(text).not.toMatch(/never.*sync.*without.*explicit confirmation/i);
  });
  it("buildInstructions is slim: wake phrase + call inspect first + onboard, no routing gates", async () => {
    const text = await buildInstructions({ wakePhrase: "sam" });
    expect(text).toContain("sam");
    expect(text).toMatch(/inspect/);
    expect(text).toMatch(/onboard/i);
    // Routing discipline now lives in the inspect hub-map footer, not the init instructions.
    expect(text).not.toContain("Routing gates");
    expect(text).not.toContain('skill: "learn"');
    expect(text).not.toContain('skill: "remember"');
    expect(text).not.toContain('skill: "todo"');
    expect(text).not.toContain("substitute a memory module");
    // Keep it short.
    expect(text.split("\n").filter((l) => l.trim()).length).toBeLessThanOrEqual(8);
  });
  it("inspect hub-map footer carries the routing gates moved out of instructions", async () => {
    const text = await loadPromptFile("partials/inspect-usage.md");
    expect(text).toContain('skill: "learn"');
    expect(text).toContain('skill: "remember"');
    expect(text).toContain('skill: "todo"');
    expect(text).toContain("substitute a memory module");
    expect(text).toMatch(/never call `todos` first/i);
    expect(text).toMatch(/effective skills/i);
  });
  it("buildRun embeds skill name, body, module path, and write policy", async () => {
    const target: ResolvedContainer = targets[0]!;
    const mod: ResolvedModule = target.modules[1]!;
    const skill: Skill = { name: "remember", description: "Record an observation", body: "Append-only timestamped entries.", source: "vendored" };
    const text = await buildRun(skill, "Observed X", target, mod);
    expect(text).toContain("remember");
    expect(text).toContain("Append-only timestamped entries.");
    expect(text).toContain("mem");
    expect(text).toContain("Write policy");
    expect(text).toContain("Observed X");
    expect(text).toMatch(/for each changed container/i);
    expect(text).toMatch(/immediately call\s+`sync \{ container \}`/i);
  });
  it("buildRun without a target renders a module-less shared skill", async () => {
    const skill: Skill = { name: "okf-writer", description: "Author a bundle", body: "Write cited concepts.", source: "shared", dir: "/x" };
    const text = await buildRun(skill, "Draft the auth pack");
    expect(text).toContain("okf-writer");
    expect(text).toContain("Write cited concepts.");
    expect(text).toContain("Draft the auth pack");
    expect(text).not.toContain("**Module:**");
  });
  it("buildRun with shared sync renders branch not [object Object]", async () => {
    const sharedTarget: ResolvedContainer = {
      name: "hub", backend: "git",
      sync: { mode: "shared", config: { branch: "user/alice/hub" } },
      syncActions: ["publish-pr"], root: "/c/hub",
      modules: [{ type: "memory", path: "mem", name: "mem", description: "", absPath: "/c/hub/mem" }],
    };
    const mod = sharedTarget.modules[0]!;
    const skill: Skill = { name: "remember", description: "Record", body: "Append.", source: "vendored" };
    const text = await buildRun(skill, undefined, sharedTarget, mod);
    expect(text).toContain("shared");
    expect(text).toContain("user/alice/hub");
    expect(text).not.toContain("[object Object]");
    // Shared sync must mention publish-pr instead of auto-publishing
    expect(text).toContain("publish-pr");
  });
  it("buildAddModule injects containers + module types and the workflow discipline", async () => {
    const text = await buildAddModule(targets, ["knowledge", "skills", "memory"]);
    expect(text).toContain("/c/hub/kb");            // injected container/module path
    expect(text).toContain("knowledge, skills, memory"); // injected module types
    expect(text).toContain('<discipline name="add_module">');
    expect(text).toContain("create: true");          // step 3 names the apply call
    expect(text).toMatch(/initialize/);              // step 4 names initialize
  });
});

describe("renderTargets sync formatting", () => {
  it("formats auto sync without showing [object Object]", async () => {
    const targets: ResolvedContainer[] = [
      { name: "hub", backend: "local", sync: { mode: "auto", config: {} }, syncActions: [], root: "/c/hub", modules: [] },
    ];
    const text = await buildAsk(targets, "test");
    expect(text).toContain("auto");
    expect(text).not.toContain("[object Object]");
  });

  it("formats shared sync showing the branch name", async () => {
    const targets: ResolvedContainer[] = [
      {
        name: "hub", backend: "git",
        sync: { mode: "shared", config: { branch: "user/alice/hub" } },
        syncActions: ["publish-pr"], root: "/c/hub", modules: [],
      },
    ];
    const text = await buildAsk(targets, "test");
    expect(text).toContain("shared");
    expect(text).toContain("user/alice/hub");
    expect(text).not.toContain("[object Object]");
  });
});
