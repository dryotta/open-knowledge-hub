import { describe, it, expect, afterEach } from "vitest";
import { mkdir, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupEvalEnvironments,
  evalEnvironmentLabel,
  provisionEnvironment,
  environments,
  isEnvName,
} from "../eval/environments.js";
import { makeTempDir, testRun } from "../test/helpers.js";
import { fileEtag, stagingDirectory } from "../src/workspaces/files.js";
import { parseProjectReadme } from "../src/workspaces/markdown.js";
import { readEvents, runHistory, successfulResults } from "../src/workspaces/events.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const exists = async (p: string) => !!(await stat(p).catch(() => null));

describe("environments", () => {
  it("defines exactly the eval environments", () => {
    expect(Object.keys(environments).sort()).toEqual([
      "custom",
      "empty",
      "git",
      "health",
      "local-and-git",
      "wiki",
      "workspace",
    ]);
    expect(isEnvName("git")).toBe(true);
    expect(isEnvName("nope")).toBe(false);
  });

  it("scopes automated environment labels to one validated run id", () => {
    expect(evalEnvironmentLabel("git", "run-123")).toBe("run-123-git");
    expect(() => evalEnvironmentLabel("git", "../other")).toThrow(/invalid eval run id/i);
    const previous = process.env.OKH_EVAL_RUN_ID;
    delete process.env.OKH_EVAL_RUN_ID;
    try {
      expect(evalEnvironmentLabel("git")).toBe("git");
    } finally {
      if (previous === undefined) delete process.env.OKH_EVAL_RUN_ID;
      else process.env.OKH_EVAL_RUN_ID = previous;
    }
  });

  it("cleans only temp roots belonging to the requested eval run", async () => {
    const parent = await makeTempDir("okh-eval-clean-");
    cleanups.push(parent);
    const ownedA = join(parent, "okh-eval-run-123-git-a");
    const ownedB = join(parent, "okh-eval-run-123-wiki-b");
    const other = join(parent, "okh-eval-run-999-git-c");
    await Promise.all([mkdir(ownedA), mkdir(ownedB), mkdir(other)]);

    const removed = await cleanupEvalEnvironments("run-123", parent);

    expect(removed.sort()).toEqual([ownedA, ownedB].sort());
    expect(await exists(ownedA)).toBe(false);
    expect(await exists(ownedB)).toBe(false);
    expect(await exists(other)).toBe(true);
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

  it("workspace seeds valid lifecycle state and commits a clean baseline", async () => {
    const prov = await provisionEnvironment("workspace", {
      repoRoot: "C:/repo",
      runner: testRun,
    });
    cleanups.push(prov.root);

    const registry = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    const byName = Object.fromEntries(
      registry.containers.map((entry: { name: string }) => [entry.name, entry]),
    );
    expect(Object.keys(byName).sort()).toEqual(["personal-hub", "work-hub"]);
    expect(byName["work-hub"].backend.type).toBe("git");
    expect(byName["personal-hub"].backend.type).toBe("local");
    expect(prov.containerPaths).toMatchObject({
      "work-hub": byName["work-hub"].localPath,
      "personal-hub": byName["personal-hub"].localPath,
    });
    expect(await exists(prov.baselinePaths!["work-hub"]!)).toBe(true);
    expect(await exists(prov.baselinePaths!["personal-hub"]!)).toBe(true);
    expect(await exists(prov.stagingBaselinePath!)).toBe(true);
    expect(await exists(join(
      prov.stagingBaselinePath!,
      "work-hub",
      "investigations",
      "supplier-risk",
      "2026-06-25-001",
      "draft.md",
    ))).toBe(true);
    expect(prov.fixtureDir).toBe(prov.baselinePaths!["work-hub"]);
    expect(prov.baselineCommitCount).toBe(2);

    const work = prov.containerPaths!["work-hub"]!;
    const launchRoot = join(work, "presentations", "projects", "launch-readiness");
    const launchReadme = join(launchRoot, "README.md");
    const launch = parseProjectReadme(
      "launch-readiness",
      await readFile(launchReadme, "utf8"),
      await fileEtag(launchReadme),
    );
    const launchEvents = await readEvents(join(launchRoot, "events.json"), work);
    expect(launch).toMatchObject({
      status: "archived",
      activeRun: null,
      tags: ["launch"],
    });
    expect(successfulResults(launchEvents).map((result) => result.runId)).toEqual([
      "2026-06-15-001",
      "2026-06-01-001",
    ]);
    expect(launch.result).toContain("2026-06-15-001");

    const supplierRoot = join(work, "investigations", "projects", "supplier-risk");
    const supplierReadme = join(supplierRoot, "README.md");
    const supplier = parseProjectReadme(
      "supplier-risk",
      await readFile(supplierReadme, "utf8"),
      await fileEtag(supplierReadme),
    );
    const supplierEvents = await readEvents(join(supplierRoot, "events.json"), work);
    expect(supplier.activeRun).toBe("2026-06-25-001");
    expect(runHistory(supplierEvents, supplier.activeRun!).state).toBe("paused");
    expect(
      await readFile(
        join(
          stagingDirectory(
            {
              home: prov.okhHome,
              containersDir: join(prov.okhHome, "containers"),
              registryFile: join(prov.okhHome, "registry.json"),
              preferencesFile: join(prov.okhHome, "preferences.json"),
            },
            "work-hub",
            "investigations",
            "supplier-risk",
            supplier.activeRun!,
          ),
          "draft.md",
        ),
        "utf8",
      ),
    ).toContain("decision-owner preference");

    for (const container of ["work-hub", "personal-hub"]) {
      expect(
        await exists(
          join(
            prov.containerPaths![container]!,
            container === "work-hub" ? "presentations" : "writing",
            "projects",
            "quarterly-review",
            "README.md",
          ),
        ),
      ).toBe(true);
    }

    const { stdout: statusOutput } = await testRun(
      "git",
      ["status", "--porcelain"],
      { cwd: work },
    );
    expect(statusOutput.trim()).toBe("");
  });
});
