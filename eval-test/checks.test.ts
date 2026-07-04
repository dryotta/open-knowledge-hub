import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../test/helpers.js";
import { evaluateCheck } from "../eval/assertions/checks.js";

const cleanups: string[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function okhHomeWith(name: string, module?: string): Promise<string> {
  const home = await makeTempDir(); cleanups.push(home);
  const c = join(home, "containers", name);
  await mkdir(join(c, ".okh"), { recursive: true });
  const mods = module ? `modules:\n  - path: ${module}\n    type: knowledge\n` : "modules: []\n";
  await writeFile(join(c, ".okh", "okh.yaml"), `name: ${name}\nsync: auto\n${mods}`, "utf8");
  await writeFile(join(home, "registry.json"), JSON.stringify({ version: 1, containers: [{ name, backend: "local", localPath: c, addedAt: new Date().toISOString() }] }), "utf8");
  return home;
}

describe("evaluateCheck", () => {
  it("tool: passes when the tool was called", async () => {
    expect((await evaluateCheck({ kind: "tool", name: "add" }, { toolCalls: ["add", "inspect"], transcript: "" })).pass).toBe(true);
    expect((await evaluateCheck({ kind: "tool", name: "sync" }, { toolCalls: ["add"], transcript: "" })).pass).toBe(false);
  });
  it("container: passes for a registered container + module", async () => {
    const okhHome = await okhHomeWith("my-notes", "kb");
    expect((await evaluateCheck({ kind: "container", name: "my-notes", backend: "local", module: "kb" }, { okhHome, transcript: "" })).pass).toBe(true);
    expect((await evaluateCheck({ kind: "container", name: "ghost" }, { okhHome, transcript: "" })).pass).toBe(false);
  });
  it("manifest: passes when the container manifest parses", async () => {
    const okhHome = await okhHomeWith("h");
    expect((await evaluateCheck({ kind: "manifest", name: "h" }, { okhHome, transcript: "" })).pass).toBe(true);
  });
  it("wake-phrase: passes when a non-default phrase is persisted", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    await writeFile(join(home, "preferences.json"), JSON.stringify({ wakePhrase: "brain" }), "utf8");
    expect((await evaluateCheck({ kind: "wake-phrase", default: "hub" }, { okhHome: home, transcript: "" })).pass).toBe(true);
  });
  it("transcript-contains / transcript-absent", async () => {
    expect((await evaluateCheck({ kind: "transcript-contains", pattern: "Plan \\(no changes" }, { transcript: "Plan (no changes made)" })).pass).toBe(true);
    expect((await evaluateCheck({ kind: "transcript-absent", pattern: "error" }, { transcript: "all good" })).pass).toBe(true);
  });
});
