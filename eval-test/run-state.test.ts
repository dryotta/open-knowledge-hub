import { describe, it, expect, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../test/helpers.js";
import { recordRun, readRuns, resolveRun, forgetRun, type RunRecord } from "../eval/run-state.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRun(scenario: string): Promise<RunRecord> {
  const root = await makeTempDir(`okh-run-${scenario}-`);
  dirs.push(root);
  const workspace = join(root, "workspace");
  const copilotHome = join(root, "copilot-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(copilotHome, { recursive: true });
  return { scenario, root, workspace, copilotHome, backend: "local", createdAt: new Date().toISOString() };
}

async function stateFile(): Promise<string> {
  const dir = await makeTempDir("okh-state-");
  dirs.push(dir);
  return join(dir, "state.json");
}

describe("run-state", () => {
  it("resolves a recorded run by scenario name", async () => {
    const state = await stateFile();
    const rec = await makeRun("ask-grounded");
    await recordRun(rec, state);
    expect((await resolveRun("ask-grounded", state)).root).toBe(rec.root);
  });

  it("resolves the most-recent run when no scenario is given", async () => {
    const state = await stateFile();
    const first = await makeRun("ask-grounded");
    const second = await makeRun("remember-records");
    await recordRun(first, state);
    await recordRun(second, state);
    expect((await resolveRun(undefined, state)).scenario).toBe("remember-records");
  });

  it("re-recording the same scenario replaces its entry and makes it most-recent", async () => {
    const state = await stateFile();
    const older = await makeRun("ask-grounded");
    const other = await makeRun("remember-records");
    const newer = await makeRun("ask-grounded");
    await recordRun(older, state);
    await recordRun(other, state);
    await recordRun(newer, state);
    const runs = await readRuns(state);
    expect(runs.filter((r) => r.scenario === "ask-grounded").length).toBe(1);
    expect((await resolveRun(undefined, state)).root).toBe(newer.root);
  });

  it("throws a clear error when the resolved run directory is gone", async () => {
    const state = await stateFile();
    const rec = await makeRun("ask-grounded");
    await recordRun(rec, state);
    await rm(rec.root, { recursive: true, force: true });
    await expect(resolveRun("ask-grounded", state)).rejects.toThrow(/re-run/i);
  });

  it("throws a clear error when no run matches", async () => {
    const state = await stateFile();
    await expect(resolveRun(undefined, state)).rejects.toThrow(/setup/i);
  });

  it("forgetRun removes only the matching entry", async () => {
    const state = await stateFile();
    const a = await makeRun("ask-grounded");
    const b = await makeRun("remember-records");
    await recordRun(a, state);
    await recordRun(b, state);
    await forgetRun(a.root, state);
    expect((await readRuns(state)).map((r) => r.scenario)).toEqual(["remember-records"]);
  });

  it("readRuns returns [] when the state file is absent", async () => {
    const state = await stateFile();
    expect(await readRuns(state)).toEqual([]);
  });
});
