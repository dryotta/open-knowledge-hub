import { describe, it, expect, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listScenarios, loadScenario, setupScenario, runChecks, clean, buildEnterInvocation } from "../eval/okh-eval.js";
import { type RunRecord } from "../eval/run-state.js";
import { makeTempDir } from "../test/helpers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => clean(r)));
});

describe("okh-eval manual CLI", () => {
  it("lists all 16 scenarios", async () => {
    expect((await listScenarios()).length).toBe(16);
  });

  it("loads a scenario's prompt (from prompt.md) + env", async () => {
    const s = await loadScenario("ask-grounded");
    expect(s.vars.env).toBe("local-and-git");
    expect(s.prompt).toMatch(/auth/i);
  });

  it("setup provisions a workspace and prints a copilot command", async () => {
    const res = await setupScenario("ask-grounded", { model: "test-model" });
    roots.push(res.root);
    expect(res.command).toContain("copilot -p");
    expect(res.command).toContain("--allow-all");
    expect(res.checklist.length).toBeGreaterThan(0);
  });

  it("setup prints a command that matches the host shell", async () => {
    const res = await setupScenario("ask-grounded", { model: "test-model" });
    roots.push(res.root);
    if (process.platform === "win32") {
      expect(res.command).toContain("$env:COPILOT_HOME=");
      expect(res.command).toContain("Set-Location -LiteralPath");
    } else {
      expect(res.command).toContain("COPILOT_HOME=");
    }
  });

  it("setup returns the scenario name and backend for state tracking", async () => {
    const res = await setupScenario("ask-grounded", { model: "test-model" });
    roots.push(res.root);
    expect(res.scenario).toBe("ask-grounded");
    expect(res.backend).toBe("local");
  });

  it("setup registers both containers for the multi-container scenario", async () => {
    const res = await setupScenario("ask-multi-container", { model: "test-model" });
    roots.push(res.root);
    const reg = JSON.parse(await readFile(join(res.root, "okh-home", "registry.json"), "utf8"));
    expect(reg.containers.map((c: { name: string }) => c.name).sort()).toEqual(["git-hub", "kb-hub"]);
  });

  it("buildEnterInvocation targets the isolated env and workspace", () => {
    const rec: RunRecord = {
      scenario: "ask-grounded",
      root: "/r",
      workspace: "/r/ws",
      copilotHome: "/r/ch",
      backend: "local",
      createdAt: "t",
    };
    const inv = buildEnterInvocation(rec, "test-model");
    expect(inv.command).toBe("copilot");
    expect(inv.args).toEqual(["--allow-all", "--model", "test-model"]);
    expect(inv.cwd).toBe("/r/ws");
    expect(inv.env.COPILOT_HOME).toBe("/r/ch");
  });

  it("buildEnterInvocation omits --model when not given", () => {
    const rec: RunRecord = {
      scenario: "s",
      root: "/r",
      workspace: "/r/ws",
      copilotHome: "/r/ch",
      backend: "local",
      createdAt: "t",
    };
    expect(buildEnterInvocation(rec).args).toEqual(["--allow-all"]);
  });

  it("runChecks evaluates filesystem side-effects (memory append)", async () => {
    const res = await setupScenario("remember-records");
    roots.push(res.root);
    // simulate the agent adding a new dated memory entry
    await mkdir(join(res.containerPath, "mem"), { recursive: true });
    await writeFile(join(res.containerPath, "mem", "2026-07-02.md"), "## new\n", "utf8");
    const results = await runChecks(res.root, "remember-records");
    const mem = results.find((r) => r.name.endsWith("memory-append.ts"));
    expect(mem?.pass).toBe(true);
    // transcript/tools checks are skipped in manual mode (no transcript)
    expect(results.some((r) => r.name.endsWith("tools-called.ts"))).toBe(false);
  });

  it("runChecks tolerates a scenario container that is not registered", async () => {
    const root = await makeTempDir("okh-eval-empty-");
    roots.push(root);
    const okhHome = join(root, "okh-home");
    await mkdir(okhHome, { recursive: true });
    await writeFile(join(okhHome, "registry.json"), JSON.stringify({ version: 1, containers: [] }), "utf8");

    await expect(runChecks(root, "ask-grounded")).resolves.toEqual([]);
  });
});
