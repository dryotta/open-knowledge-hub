import { describe, it, expect, afterEach } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadScenarios, listEnvironments, scenariosForEnv, setupEnvironment, clean, buildEnterInvocation, runManualSession } from "../eval/okh-eval.js";
import { type RunRecord } from "../eval/run-state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => clean(r)));
});
const exists = async (p: string) => !!(await stat(p).catch(() => null));

describe("okh-eval manual CLI (environment-centric)", () => {
  it("lists the eval environments", () => {
    expect(listEnvironments().sort()).toEqual(["custom", "empty", "git", "health", "local-and-git", "wiki"]);
  });

  it("loads 29 scenario configs with inline prompts + envs, recursively", async () => {
    const all = await loadScenarios();
    expect(all.length).toBe(29);
    for (const s of all) {
      expect(typeof s.prompt).toBe("string");
      expect(s.prompt.length).toBeGreaterThan(0);
      expect(["empty", "git", "local-and-git", "custom", "health", "wiki"]).toContain(s.env);
      expect(s.file).toMatch(/^[a-z-]+\/[a-z-]+\.yaml$/);
    }
  });

  it("groups tests by environment", async () => {
    expect((await scenariosForEnv("local-and-git")).length).toBe(12);
    expect((await scenariosForEnv("git")).length).toBe(1);
    expect((await scenariosForEnv("empty")).length).toBe(9);
    expect((await scenariosForEnv("custom")).length).toBe(2);
    expect((await scenariosForEnv("wiki")).length).toBe(3);
    expect((await scenariosForEnv("health")).length).toBe(2);
  });

  it("setup provisions local-and-git and lists its prompts + checklists", async () => {
    const res = await setupEnvironment("local-and-git");
    roots.push(res.root);
    expect(res.env).toBe("local-and-git");
    expect(res.prompts.length).toBe(12);
    expect(res.prompts[0].description).toMatch(/\S/);
    expect(res.prompts[0].prompt.length).toBeGreaterThan(0);
    expect(res.prompts[0].checklist.length).toBeGreaterThan(0);
    const reg = JSON.parse(await readFile(join(res.root, "okh-home", "registry.json"), "utf8"));
    expect(reg.containers.map((c: { name: string }) => c.name).sort()).toEqual(["git-hub", "kb-hub"]);
  });

  it("setup empty leaves an empty registry with an unregistered notes folder", async () => {
    const res = await setupEnvironment("empty");
    roots.push(res.root);
    expect(res.prompts.length).toBe(9);
    const reg = JSON.parse(await readFile(join(res.root, "okh-home", "registry.json"), "utf8"));
    expect(reg.containers).toHaveLength(0);
    expect(await exists(join(res.workspace, "notes"))).toBe(true);
  });

  it("buildEnterInvocation targets the isolated env and workspace", () => {
    const rec: RunRecord = { env: "local-and-git", root: "/r", workspace: "/r/ws", copilotHome: "/r/ch", createdAt: "t" };
    const inv = buildEnterInvocation(rec, "test-model");
    expect(inv.command).toBe("copilot");
    expect(inv.args).toEqual(["--allow-all", "--model", "test-model"]);
    expect(inv.cwd).toBe("/r/ws");
    expect(inv.env.COPILOT_HOME).toBe("/r/ch");
  });

  it("buildEnterInvocation omits --model when not given", () => {
    const rec: RunRecord = { env: "empty", root: "/r", workspace: "/r/ws", copilotHome: "/r/ch", createdAt: "t" };
    expect(buildEnterInvocation(rec).args).toEqual(["--allow-all"]);
  });

  it("manual provisions a temp env, runs the session, and cleans up on exit", async () => {
    let root = "";
    let existedDuringSession = false;
    let seenCwd = "";
    const code = await runManualSession("empty", {
      onSetup: (res) => { root = res.root; },
      spawn: async (inv) => {
        seenCwd = inv.cwd;
        existedDuringSession = await exists(root);
        return 7;
      },
    });
    expect(code).toBe(7);
    expect(existedDuringSession).toBe(true);
    expect(seenCwd).toBe(join(root, "workspace"));
    expect(await exists(root)).toBe(false);
  });

  it("manual cleans up the temp env even when the session errors", async () => {
    let root = "";
    await expect(
      runManualSession("empty", {
        onSetup: (res) => { root = res.root; },
        spawn: async () => { throw new Error("boom"); },
      }),
    ).rejects.toThrow("boom");
    expect(root).not.toBe("");
    expect(await exists(root)).toBe(false);
  });
});
