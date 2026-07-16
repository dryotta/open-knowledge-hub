import { rm } from "node:fs/promises";
import { afterEach, describe, it, expect } from "vitest";
import { ContainerService, type ResolvedContainer, type ResolvedModule } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { buildAddModule, buildAsk, buildContext, buildInstructions, buildOnboard, buildRun } from "../src/prompts/index.js";
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
    expect(text).toMatch(/issued at login and verified on each request[\s\S]{0,100}not that\s+issuance causes verification/i);
    expect(text).toMatch(/do not add generic benefits/i);
    expect(text).toMatch(/do not specialize a generic source\s+term/i);
    expect(text).toMatch(/exact path relative to the module root/i);
    expect(text).toMatch(/never add an assumed directory/i);
    expect(text).toMatch(/never attach a source citation\s+to a detail that source does not contain/i);
    expect(text).toMatch(/<container>\/<module>\/<exact item path>/i);
    expect(text).toMatch(/do not remove, weaken,\s+combine, or rewrite the sub-agent's citations/i);
    expect(text).toMatch(/for one pack, run it in the foreground and wait for its result/i);
    expect(text).toMatch(/background sub-agents may run in parallel[\s\S]{0,100}wait for every\s+result/i);
    expect(text).toMatch(/still include the distilled answer itself/i);
    expect(text).toMatch(/do not replace it with a\s+statement that the answer was retrieved or handled/i);
    expect(text).toMatch(/explicit user constraints\s+override the default gap elaboration/i);
    expect(text).toMatch(/omit coverage, gap, and next-step sections/i);
    expect(text).toMatch(/never name missing technologies, mechanisms, categories/i);
    expect(text).toMatch(/do not relabel the\s+relationship as causal or correlational/i);
    expect(text).toMatch(/neither classification is\s+established rather than forcing each fact into a category/i);
    expect(text).toMatch(/headings and bullet labels are\s+claims too/i);
    expect(text).toMatch(/forbids listing those absent details as coverage gaps/i);
    expect(text).toMatch(/if the sub-agent added a prohibited gap or next-step section, omit that\s+section/i);
    expect(text).toMatch(/verify every citation against\s+the provided module and item paths/i);
    expect(text).toMatch(/for a facts-only request[\s\S]{0,120}end\s+after the last fact/i);
    expect(text).toMatch(/remove cross-source comparisons, coverage notes, and missing-topic summaries/i);
  });
  it("context uses the context discipline", async () => {
    expect(await buildContext(targets, "Ship the feature")).toMatch(/working set/i);
  });
  it("context discipline keeps rejected candidates out of the selected working set", async () => {
    const text = await buildContext(targets, "Debug CSV import");
    expect(text).toMatch(/caller's original request is authoritative/i);
    expect(text).toMatch(/only user-stated details define scope/i);
    expect(text).toMatch(/never create a bullet\s+for an excluded item/i);
    expect(text).toMatch(/gap summary[\s\S]{0,120}must not name or cite[\s\S]{0,80}rejected item/i);
    expect(text).toMatch(/never select.{0,160}(filename|recency)/is);
    expect(text).toMatch(/do not\s+open clearly irrelevant candidates merely to confirm their rejection/i);
    expect(text).toMatch(/do not select a debugging skill[\s\S]{0,100}unless the task includes a failure to debug/i);
    expect(text).toMatch(/never put\s+a conditional item in the selected working set/i);
    expect(text).toMatch(/do not invent concrete libraries, algorithms/i);
    expect(text).toMatch(/same broad\s+level without examples or an invented checklist/i);
    expect(text).toMatch(/complete listed\s+item path/i);
    expect(text).toMatch(/under a `## Gaps` heading/i);
  });
  it("context discipline includes relevant nested files from custom and tool modules", async () => {
    const text = await buildContext(targets, "Debug CSV import");
    expect(text).toMatch(/custom\/tool modules/i);
    expect(text).toMatch(/utilities and references/i);
  });
  it("onboard includes staged guidance, the wake phrase, and config routing", async () => {
    const text = await buildOnboard(targets, { wakePhrase: "sam" });
    expect(text).toContain("sam");
    expect(text).toMatch(/Stage 1/);
    expect(text).toContain("config { set: { wakePhrase");
    expect(text).toMatch(/confirmation must be a later user message/i);
    expect(text).toMatch(/once the preview returns,[\s\S]{0,100}end the turn/i);
    expect(text).not.toContain("onboard { wakePhrase");
    // Confirmation is only for setup (folders/containers/modules), not ordinary sync
    expect(text).not.toMatch(/never.*sync.*without.*explicit confirmation/i);
  });
  it("buildInstructions routes deterministic todo work through todos while preserving remember and todo skill distinctions", async () => {
    const text = await buildInstructions({ wakePhrase: "sam" });
    expect(text).toContain("Routing gates");
    expect(text).toContain('skill: "learn"');
    expect(text).toContain("Do not");
    expect(text).toContain("substitute a memory module");
    expect(text).toMatch(/never call `todos` first/i);
    expect(text).toContain('skill: "remember"');
    expect(text).toContain('skill: "todo"');
    expect(text).toContain("Every deterministic todo operation still goes through `todos`");
    expect(text).toContain("Call `todos` directly only to read/list/filter todos");
    expect(text).not.toContain("update_todo");
    expect(text).not.toContain("without bypassing or restarting it");
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
