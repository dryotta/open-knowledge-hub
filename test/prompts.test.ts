import { rm } from "node:fs/promises";
import { afterEach, describe, it, expect } from "vitest";
import { ContainerService, type ResolvedContainer } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { loadOkf, loadDiscipline, combineOkf } from "../src/prompts/discipline.js";
import { buildAsk, buildContext, buildLearn, buildRemember, buildReflect } from "../src/prompts/index.js";
import { makePaths, makeTempDir, testRun } from "./helpers.js";

class FakeGh { async createRepo(){return "x";} async createPr(){return "x";} }
const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("discipline loader", () => {
  it("loads a vendored OKF doc", async () => {
    const text = await loadOkf("okf-ask");
    expect(text.length).toBeGreaterThan(0);
  });

  it("loads a new v2 discipline doc", async () => {
    expect(await loadDiscipline("remember")).toMatch(/append/i);
    expect(await loadDiscipline("context")).toMatch(/working set/i);
    expect(await loadDiscipline("reflect")).toMatch(/insight/i);
  });

  it("combineOkf wraps each doc in a named discipline block", async () => {
    const combined = await combineOkf(["okf-ask"]);
    expect(combined).toContain('<discipline name="okf-ask">');
    expect(combined).toContain("</discipline>");
  });
});

describe("resolveTargets", () => {
  it("resolves module abs paths for a container, and errors on unknown module", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const dir = await makeTempDir(); cleanups.push(dir);
    const service = new ContainerService(makePaths(home), new Git(testRun), new FakeGh() as unknown as Gh);
    await service.addContainer({ source: dir, name: "hub" });
    await service.addModule({ container: "hub", path: "kb", type: "knowledge" });
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
    await service.addContainer({ source: a, name: "a" });
    await service.addContainer({ source: b, name: "b" });
    expect(await service.resolveTargets()).toHaveLength(2);
  });
});

describe("prompt builders", () => {
  const targets: ResolvedContainer[] = [
    { name: "hub", backend: "local", sync: "auto", root: "/c/hub", modules: [
      { type: "knowledge", path: "kb", absPath: "/c/hub/kb" },
      { type: "memory", path: "mem", absPath: "/c/hub/mem" },
    ] },
  ];
  it("ask includes the question, the target path, and the okf-ask discipline", async () => {
    const text = await buildAsk(targets, "How does auth work?");
    expect(text).toContain("How does auth work?");
    expect(text).toContain("/c/hub/kb");
    expect(text).toContain('<discipline name="okf-ask">');
  });
  it("context uses the context discipline", async () => {
    expect(await buildContext(targets, "Ship the feature")).toMatch(/working set/i);
  });
  it("learn embeds the OKF write discipline + the write policy", async () => {
    const text = await buildLearn(targets, "New fact");
    expect(text).toContain('<discipline name="okf-learn">');
    expect(text).toMatch(/sync/i);
  });
  it("remember + reflect embed their disciplines", async () => {
    expect(await buildRemember(targets, "Observed X")).toMatch(/append/i);
    expect(await buildReflect(targets, undefined)).toMatch(/insight/i);
  });
});
