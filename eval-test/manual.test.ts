import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { Provisioned } from "../eval/environments.js";
import {
  DEFAULT_MANUAL_ENV,
  buildCopilotInvocation,
  launchCopilot,
  loadScenarios,
  parseManualArgs,
  runManual,
  scenariosForEnv,
} from "../eval/manual.js";

const provisioned: Provisioned = {
  root: "C:\\temp\\manual-root",
  okhHome: "C:\\temp\\manual-root\\okh-home",
  copilotHome: "C:\\temp\\manual-root\\copilot-home",
  workspace: "C:\\temp\\manual-root\\workspace",
  containerPath: "C:\\temp\\manual-root\\okh-home\\containers\\kb-hub",
  fixtureDir: "C:\\repo\\eval\\fixtures\\kb-hub",
};

class FakeChildProcess extends EventEmitter {
  killed = false;
  readonly forwardedSignals: NodeJS.Signals[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    if (signal) {
      this.forwardedSignals.push(signal);
    }
    return true;
  }
}

describe("manual testing helpers", () => {
  it("defaults to local-and-git", () => {
    expect(parseManualArgs([])).toEqual({ env: DEFAULT_MANUAL_ENV, model: undefined });
  });

  it("accepts explicit wiki env and model", () => {
    expect(parseManualArgs(["wiki", "--model", "claude-sonnet-4.5"])).toEqual({
      env: "wiki",
      model: "claude-sonnet-4.5",
    });
  });

  it.each([
    [["unknown"], /unknown environment/i],
    [["--model"], /requires a value/i],
    [["wiki", "git"], /unexpected argument/i],
    [["--wat"], /unknown option/i],
  ])("rejects invalid arguments: %j", (argv, message) => {
    expect(() => parseManualArgs(argv as string[])).toThrow(message);
  });

  it("loads all scenario prompts and groups them by environment", async () => {
    const all = await loadScenarios();
    expect(all).toHaveLength(28);
    expect(await scenariosForEnv("local-and-git")).toHaveLength(12);
    expect(await scenariosForEnv("git")).toHaveLength(1);
    expect(await scenariosForEnv("empty")).toHaveLength(8);
    expect(await scenariosForEnv("custom")).toHaveLength(2);
    expect(await scenariosForEnv("wiki")).toHaveLength(3);
    expect(await scenariosForEnv("health")).toHaveLength(2);
    for (const scenario of all) {
      expect(scenario.prompt).not.toHaveLength(0);
      expect(scenario.checklist).not.toHaveLength(0);
    }
  });

  it("builds an isolated Copilot invocation", () => {
    expect(
      buildCopilotInvocation(
        { workspace: "C:\\temp\\workspace", copilotHome: "C:\\temp\\copilot-home" },
        "test-model",
      ),
    ).toEqual({
      command: "copilot",
      args: ["--allow-all", "--model", "test-model"],
      cwd: "C:\\temp\\workspace",
      env: { COPILOT_HOME: "C:\\temp\\copilot-home" },
    });
  });
});

describe("runManual", () => {
  it("provisions the default env, prints prompts, launches Copilot, and cleans up", async () => {
    const events: string[] = [];
    const exitCode = await runManual([], {
      provision: async (env) => {
        events.push(`provision:${env}`);
        return provisioned;
      },
      scenarios: async () => [{
        file: "ask/answerable.yaml",
        description: "answers from stored knowledge",
        env: "local-and-git",
        prompt: "What is the deployment process?",
        checklist: ["tools-called ask"],
      }],
      launch: async (invocation) => {
        events.push(`launch:${JSON.stringify(invocation)}`);
        return 7;
      },
      cleanup: async (root) => {
        events.push(`cleanup:${root}`);
      },
      output: (line) => events.push(`output:${line}`),
    });

    expect(exitCode).toBe(7);
    expect(events).toContain("provision:local-and-git");
    expect(events).toContain(
      `launch:${JSON.stringify({
        command: "copilot",
        args: ["--allow-all"],
        cwd: provisioned.workspace,
        env: { COPILOT_HOME: provisioned.copilotHome },
      })}`,
    );
    expect(events).toContain("output:Environment  : local-and-git");
    expect(events).toContain(`output:OKH_HOME     : ${provisioned.okhHome}`);
    expect(events).toContain(`output:COPILOT_HOME : ${provisioned.copilotHome}`);
    expect(events).toContain(`output:Workspace    : ${provisioned.workspace}`);
    expect(events).toContain("output:[1] answers from stored knowledge");
    expect(events).toContain("output:What is the deployment process?");
    expect(events).toContain("output:  expected:");
    expect(events).toContain("output:    - tools-called ask");
    expect(events).toContain(`cleanup:${provisioned.root}`);
    expect(events.at(-1)).toBe(`output:Cleaned ${provisioned.root}`);
  });

  it("cleans up when Copilot launch fails", async () => {
    const cleaned: string[] = [];
    const output: string[] = [];
    await expect(runManual(["wiki"], {
      provision: async () => provisioned,
      scenarios: async () => [],
      launch: async () => {
        throw new Error("copilot unavailable");
      },
      cleanup: async (root) => {
        cleaned.push(root);
      },
      output: (line) => {
        output.push(line);
      },
    })).rejects.toThrow("copilot unavailable");
    expect(cleaned).toEqual([provisioned.root]);
    expect(output.at(-1)).toBe(`Cleaned ${provisioned.root}`);
  });

  it("rejects the cleanup error when session work succeeds but cleanup fails", async () => {
    const cleanupError = new Error("cleanup failed");
    const output: string[] = [];

    await expect(runManual([], {
      provision: async () => provisioned,
      scenarios: async () => [],
      launch: async () => 7,
      cleanup: async () => {
        throw cleanupError;
      },
      output: (line) => {
        output.push(line);
      },
    })).rejects.toBe(cleanupError);

    expect(output).not.toContain(`Cleaned ${provisioned.root}`);
  });

  it("rejects an AggregateError when both session work and cleanup fail", async () => {
    const launchError = new Error("copilot unavailable");
    const cleanupError = new Error("cleanup failed");
    const output: string[] = [];

    try {
      await runManual(["wiki"], {
        provision: async () => provisioned,
        scenarios: async () => [],
        launch: async () => {
          throw launchError;
        },
        cleanup: async () => {
          throw cleanupError;
        },
        output: (line) => {
          output.push(line);
        },
      });
      throw new Error("expected runManual to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({ message: "manual session and cleanup both failed" });
      const aggregate = error as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(launchError);
      expect(aggregate.errors[1]).toBe(cleanupError);
    }

    expect(output).not.toContain(`Cleaned ${provisioned.root}`);
  });

  it("aggregates cleanup failure even when session work throws undefined", async () => {
    const cleanupError = new Error("cleanup failed");

    try {
      await runManual(["wiki"], {
        provision: async () => provisioned,
        scenarios: async () => [],
        launch: async () => {
          throw undefined;
        },
        cleanup: async () => {
          throw cleanupError;
        },
        output: () => undefined,
      });
      throw new Error("expected runManual to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({ message: "manual session and cleanup both failed" });
      const aggregate = error as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBeUndefined();
      expect(aggregate.errors[1]).toBe(cleanupError);
    }
  });

  it("rejects invalid arguments before provisioning", async () => {
    let provisionedCount = 0;
    await expect(runManual(["bad-env"], {
      provision: async () => {
        provisionedCount += 1;
        return provisioned;
      },
      scenarios: async () => [],
      launch: async () => 0,
      cleanup: async () => undefined,
      output: () => undefined,
    })).rejects.toThrow(/unknown environment/i);
    expect(provisionedCount).toBe(0);
  });
});

describe("launchCopilot", () => {
  it("delegates the bare copilot command and options to the injected spawn implementation", async () => {
    const child = new FakeChildProcess();
    let spawnCall:
      | {
          command: string;
          args: readonly string[] | undefined;
          options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; shell?: boolean } | undefined;
        }
      | undefined;
    const sigintCount = process.listenerCount("SIGINT");
    const sigtermCount = process.listenerCount("SIGTERM");

    const spawnChild = ((command: string, args?: readonly string[], options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      stdio?: unknown;
      shell?: boolean;
    }) => {
      spawnCall = { command, args, options };
      return child as never;
    }) as unknown as NonNullable<Parameters<typeof launchCopilot>[1]>;

    const launch = launchCopilot(
      {
        command: "copilot",
        args: ["--allow-all"],
        cwd: provisioned.workspace,
        env: { COPILOT_HOME: provisioned.copilotHome },
      },
      spawnChild,
    );

    try {
      expect(spawnCall).toStrictEqual({
        command: "copilot",
        args: ["--allow-all"],
        options: {
          cwd: provisioned.workspace,
          env: {
            ...process.env,
            COPILOT_HOME: provisioned.copilotHome,
          },
          stdio: "inherit",
          shell: false,
        },
      });
      expect(process.listenerCount("SIGINT")).toBe(sigintCount + 1);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermCount + 1);

      const sigintHandler = process.listeners("SIGINT")[sigintCount] as (() => void) | undefined;
      sigintHandler?.();
      expect(child.forwardedSignals).toEqual(["SIGINT"]);
    } finally {
      child.emit("close", null, "SIGINT");
    }

    await expect(launch).resolves.toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(sigintCount);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermCount);
  });

  const windowsOnly = process.platform === "win32" ? it : it.skip;

  windowsOnly("resolves a local copilot.cmd shim with the default spawn implementation", async () => {
    const shimRoot = join(
      process.cwd(),
      "eval-test",
      "runtime",
      `cross-spawn-shim-${process.pid}-${Date.now()}`,
    );
    await mkdir(shimRoot, { recursive: true });
    await writeFile(
      join(shimRoot, "copilot.cmd"),
      "@echo off\r\nexit /b 0\r\n",
      "utf8",
    );

    try {
      await expect(launchCopilot({
        command: "copilot",
        args: ["--allow-all"],
        cwd: shimRoot,
        env: {
          COPILOT_HOME: provisioned.copilotHome,
          PATH: `${shimRoot};${process.env.PATH ?? ""}`,
        },
      })).resolves.toBe(0);
    } finally {
      await rm(shimRoot, { recursive: true, force: true });
    }
  });

  it("rejects when the child emits error and restores listener counts", async () => {
    const child = new FakeChildProcess();
    let spawnCall:
      | {
          command: string;
          args: readonly string[] | undefined;
          options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; shell?: boolean } | undefined;
        }
      | undefined;
    const sigintCount = process.listenerCount("SIGINT");
    const sigtermCount = process.listenerCount("SIGTERM");

    const spawnChild = ((command: string, args?: readonly string[], options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      stdio?: unknown;
      shell?: boolean;
    }) => {
      spawnCall = { command, args, options };
      return child as never;
    }) as unknown as NonNullable<Parameters<typeof launchCopilot>[1]>;

    const launch = launchCopilot(
      {
        command: "copilot",
        args: ["--allow-all"],
        cwd: provisioned.workspace,
        env: { COPILOT_HOME: provisioned.copilotHome },
      },
      spawnChild,
    );

    const error = new Error("spawn failed");

    try {
      expect(spawnCall).toMatchObject({
        command: "copilot",
        args: ["--allow-all"],
        options: {
          cwd: provisioned.workspace,
          stdio: "inherit",
          shell: false,
        },
      });
      expect(process.listenerCount("SIGINT")).toBe(sigintCount + 1);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermCount + 1);

      child.emit("error", error);

      await expect(launch).rejects.toBe(error);
      expect(process.listenerCount("SIGINT")).toBe(sigintCount);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermCount);
    } finally {
      child.emit("close", null, "SIGINT");
      child.removeAllListeners();
    }
  });
});
