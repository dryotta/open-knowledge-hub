import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  buildPromptfooArgs,
  buildPromptfooEnv,
  launchPromptfoo,
  parseEvalMode,
  resolvedExitCode,
} from "../eval/run-scenarios.js";

describe("run-scenarios", () => {
  it("forwards eval filters, repeats, and concurrency after disabling cache", () => {
    const args = buildPromptfooArgs("eval", [
      "--filter-pattern",
      "Learn - useful",
      "--repeat",
      "3",
      "--max-concurrency",
      "2",
    ]);

    expect(args).toContain("eval");
    expect(args).toContain("--no-cache");
    expect(args.filter((arg) => arg === "--max-concurrency")).toHaveLength(1);
    expect(args.slice(-6)).toEqual([
      "--filter-pattern",
      "Learn - useful",
      "--repeat",
      "3",
      "--max-concurrency",
      "2",
    ]);
  });

  it("caps scenario concurrency at two by default", () => {
    const args = buildPromptfooArgs("eval");
    const index = args.indexOf("--max-concurrency");
    expect(args.slice(index, index + 2)).toEqual(["--max-concurrency", "2"]);
  });

  it("does not add eval-only cache flags to validation", () => {
    const args = buildPromptfooArgs("validate", ["--no-progress-bar"]);
    expect(args).toContain("validate");
    expect(args).not.toContain("--no-cache");
    expect(args.at(-1)).toBe("--no-progress-bar");
  });

  it("sets a scoped run id and disables update checks by default", () => {
    expect(buildPromptfooEnv("run-123", { PATH: "p" })).toEqual({
      PATH: "p",
      OKH_EVAL_RUN_ID: "run-123",
      PROMPTFOO_DISABLE_UPDATE: "true",
    });
    expect(buildPromptfooEnv("run-123", { PROMPTFOO_DISABLE_UPDATE: "false" }).PROMPTFOO_DISABLE_UPDATE).toBe("false");
  });

  it("rejects missing or unknown modes", () => {
    expect(parseEvalMode("eval")).toBe("eval");
    expect(parseEvalMode("validate")).toBe("validate");
    expect(() => parseEvalMode(undefined)).toThrow(/expected eval mode/i);
    expect(() => parseEvalMode("watch")).toThrow(/expected eval mode/i);
  });

  it("reports interruption even when the child exits zero", () => {
    expect(resolvedExitCode(0, null, "SIGINT")).toBe(130);
    expect(resolvedExitCode(0, null, "SIGTERM")).toBe(143);
    expect(resolvedExitCode(null, "SIGINT")).toBe(130);
    expect(resolvedExitCode(2, null)).toBe(2);
  });

  it("force-terminates and settles when promptfoo ignores the first signal", async () => {
    const signals = new EventEmitter();
    const kill = vi.fn(() => true);
    const childState = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null,
      kill,
    });
    const child = childState as unknown as ChildProcess;
    const terminate = vi.fn(async () => {
      childState.exitCode = 1;
    });

    const pending = launchPromptfoo([], {}, {
      spawnProcess: () => child,
      signalSource: {
        on: (signal, listener) => {
          signals.on(signal, listener);
        },
        off: (signal, listener) => {
          signals.off(signal, listener);
        },
      },
      platform: "linux",
      terminationGraceMs: 10,
      terminate,
    });
    signals.emit("SIGINT");

    await expect(pending).resolves.toBe(130);
    expect(kill).toHaveBeenCalledWith("SIGINT");
    expect(terminate).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
