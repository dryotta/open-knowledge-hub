import { describe, it, expect, afterEach } from "vitest";
import { mkdir, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { provisionEnvironment, environments, isEnvName } from "../eval/environments.js";
import { makeTempDir, testRun } from "../test/helpers.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const exists = async (p: string) => !!(await stat(p).catch(() => null));

describe("environments", () => {
  it("defines exactly the eval environments", () => {
    expect(Object.keys(environments).sort()).toEqual(["custom", "empty", "git", "health", "local-and-git", "wiki"]);
    expect(isEnvName("git")).toBe(true);
    expect(isEnvName("nope")).toBe(false);
  });

  it("local-and-git registers a local kb-hub + a git git-hub with isolated homes + mcp-config", async () => {
    const prov = await provisionEnvironment("local-and-git", { repoRoot: "C:/repo", runner: testRun });
    cleanups.push(prov.root);
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    const byName = Object.fromEntries(reg.containers.map((c: { name: string }) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(["git-hub", "kb-hub"]);
    expect(byName["kb-hub"].backend.type).toBe("local");
    expect(byName["git-hub"].backend.type).toBe("git");
    expect(byName["kb-hub"].localPath).toBe(prov.containerPath);
    expect(prov.originPath).toBeUndefined();
    expect(prov.fixtureDir.replace(/\\/g, "/")).toContain("fixtures/kb-hub");
    const mcp = JSON.parse(await readFile(join(prov.copilotHome, "mcp-config.json"), "utf8"));
    expect(mcp.mcpServers["open-knowledge-hub"].env.OKH_HOME).toBe(prov.okhHome);
  });

  it("git seeds a bare origin for the single git hub", async () => {
    const prov = await provisionEnvironment("git", { repoRoot: "C:/repo", runner: testRun });
    cleanups.push(prov.root);
    expect(prov.originPath).toBeTruthy();
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    expect(reg.containers[0].backend.type).toBe("git");
    expect(reg.containers[0].backend.config.origin).toBe(prov.originPath);
    const verify = await makeTempDir("okh-verify-"); cleanups.push(verify);
    await testRun("git", ["clone", prov.originPath!, join(verify, "c")]);
    expect(await exists(join(verify, "c", "kb"))).toBe(true);
  });

  it("removes the temp root when git provisioning fails after root creation", async () => {
    const parent = await makeTempDir("okh-eval-parent-");
    cleanups.push(parent);
    const root = join(parent, "known-root");
    const failure = new Error("git init failed");
    let makeTempRootCalled = false;

    await expect(
      provisionEnvironment("git", {
        repoRoot: "C:/repo",
        makeTempRoot: async (prefix) => {
          makeTempRootCalled = true;
          expect(prefix.replace(/\\/g, "/")).toContain("okh-eval-git-");
          await mkdir(root);
          return root;
        },
        runner: async (command, args, options) => {
          if (command === "git" && args[0] === "init") throw failure;
          return testRun(command, args, options);
        },
      }),
    ).rejects.toBe(failure);

    expect(makeTempRootCalled).toBe(true);
    expect(await exists(root)).toBe(false);
  });

  it("aggregates provisioning and temp-root cleanup failures in order", async () => {
    const parent = await makeTempDir("okh-eval-parent-");
    cleanups.push(parent);
    const root = join(parent, "known-root");
    const provisionError = new Error("git init failed exactly once");
    const cleanupError = new Error("temp root removal failed exactly once");

    try {
      await provisionEnvironment("git", {
        repoRoot: "C:/repo",
        makeTempRoot: async () => {
          await mkdir(root);
          return root;
        },
        removeTempRoot: async (tempRoot) => {
          expect(tempRoot).toBe(root);
          throw cleanupError;
        },
        runner: async (command, args, options) => {
          if (command === "git" && args[0] === "init") throw provisionError;
          return testRun(command, args, options);
        },
      });
      throw new Error("expected provisionEnvironment to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        message: `Failed to provision eval environment "git" and clean up temp root "${root}".`,
      });
      const aggregate = error as AggregateError;
      expect(aggregate.errors).toEqual([provisionError, cleanupError]);
      expect(aggregate.errors[0]).toBe(provisionError);
      expect(aggregate.errors[1]).toBe(cleanupError);
    }
  });

  it("empty leaves an empty registry with an unregistered notes folder in the workspace", async () => {
    const prov = await provisionEnvironment("empty", { repoRoot: "C:/repo", runner: testRun });
    cleanups.push(prov.root);
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    expect(reg.containers).toHaveLength(0);
    expect(prov.containerPath.startsWith(prov.workspace)).toBe(true);
    expect(await exists(join(prov.workspace, "notes"))).toBe(true);
  });

  it("health seeds the source file into the workspace and registers health-hub", async () => {
    const prov = await provisionEnvironment("health", { repoRoot: "C:/repo", runner: testRun });
    cleanups.push(prov.root);
    expect(await exists(join(prov.workspace, "lab-results.txt"))).toBe(true);
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    expect(reg.containers[0].name).toBe("health-hub");
  });
});
