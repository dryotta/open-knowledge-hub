import { rm } from "node:fs/promises";
import { afterEach, describe, it, expect } from "vitest";
import { ContainerService, type ResolvedContainer, type ResolvedModule } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { loadPrompt } from "../src/prompts/prompts.js";
import { buildAsk, buildContext, buildRun, buildSharedRun } from "../src/prompts/index.js";
import type { Skill } from "../src/modules/skills.js";
import { makePaths, makeTempDir, testRun } from "./helpers.js";

class FakeGh { async createRepo(){return "x";} async createPr(){return "x";} }
const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("prompt loader", () => {
  it("loads the ask prompt", async () => {
    const text = await loadPrompt("ask");
    expect(text.length).toBeGreaterThan(0);
  });

  it("loads the context prompt", async () => {
    expect(await loadPrompt("context")).toMatch(/working set/i);
  });

  it("onboard prompt is staged and routes wake-phrase changes to config", async () => {
    const text = await loadPrompt("onboard");
    expect(text).toMatch(/Stage 1/);
    expect(text).toMatch(/Stage 2/);
    expect(text).toMatch(/Stage 3/);
    expect(text).toContain("config { set: { wakePhrase");
    expect(text).not.toContain("onboard { wakePhrase");
  });
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
    { name: "hub", backend: "local", sync: "auto", root: "/c/hub", modules: [
      { type: "knowledge", path: "kb", name: "kb", description: "", absPath: "/c/hub/kb" },
      { type: "memory", path: "mem", name: "mem", description: "", absPath: "/c/hub/mem" },
    ] },
  ];
  it("ask includes the question, the target path, and the ask discipline", async () => {
    const text = await buildAsk(targets, "How does auth work?");
    expect(text).toContain("How does auth work?");
    expect(text).toContain("/c/hub/kb");
    expect(text).toContain('<discipline name="ask">');
  });
  it("context uses the context discipline", async () => {
    expect(await buildContext(targets, "Ship the feature")).toMatch(/working set/i);
  });
  it("buildRun embeds skill name, body, module path, and write policy", () => {
    const target: ResolvedContainer = targets[0]!;
    const mod: ResolvedModule = target.modules[1]!;
    const skill: Skill = { name: "remember", description: "Record an observation", body: "Append-only timestamped entries.", source: "vendored" };
    const text = buildRun(target, mod, skill, "Observed X");
    expect(text).toContain("remember");
    expect(text).toContain("Append-only timestamped entries.");
    expect(text).toContain("mem");
    expect(text).toContain("Write policy");
    expect(text).toContain("Observed X");
  });
  it("buildSharedRun embeds a module-less shared skill and its resource paths", async () => {
    const skill: Skill = { name: "okf-writer", description: "Author a bundle", body: "Write cited concepts.", source: "shared", dir: "/x" };
    const text = await buildSharedRun(skill, "Draft the auth pack");
    expect(text).toContain("okf-writer");
    expect(text).toContain("Write cited concepts.");
    expect(text).toContain("Draft the auth pack");
    expect(text).not.toContain("Write policy");
  });
});
