import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  buildPromptfooArgs,
  buildPromptfooEnv,
  launchPromptfoo,
  parseEvalMode,
  parseHarnessArgs,
  resolveScenarioConcurrency,
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

  it("uses scenario concurrency two by default and accepts a validated environment override", () => {
    const args = buildPromptfooArgs("eval", [], { env: {} });
    const index = args.indexOf("--max-concurrency");
    expect(args.slice(index, index + 2)).toEqual(["--max-concurrency", "2"]);

    const overridden = buildPromptfooArgs("eval", [], { env: { OKH_EVAL_CONCURRENCY: "3" } });
    const overriddenIndex = overridden.indexOf("--max-concurrency");
    expect(overridden.slice(overriddenIndex, overriddenIndex + 2)).toEqual(["--max-concurrency", "3"]);
    expect(resolveScenarioConcurrency({ OKH_EVAL_CONCURRENCY: "3" })).toBe(3);
    expect(() => resolveScenarioConcurrency({ OKH_EVAL_CONCURRENCY: "0" })).toThrow(/integer from 1 to 8/i);
  });

  it("does not add eval-only cache flags to validation", () => {
    const args = buildPromptfooArgs("validate", ["--no-progress-bar"]);
    expect(args).toContain("validate");
    expect(args).not.toContain("--no-cache");
    expect(args.at(-1)).toBe("--no-progress-bar");
  });

  it("sets scoped tier, run, and local judge configuration", () => {
    expect(buildPromptfooEnv("run-123", { PATH: "p" })).toEqual({
      PATH: "p",
      OKH_EVAL_RUN_ID: "run-123",
      OKH_EVAL_TIER: "full",
      OKH_EVAL_TIMINGS: "1",
      PROMPTFOO_DISABLE_UPDATE: "true",
    });
    expect(buildPromptfooEnv("run-123", {}, { tier: "smoke", judgeK: 1 })).toMatchObject({
      OKH_EVAL_RUN_ID: "run-123",
      OKH_EVAL_TIER: "smoke",
      OKH_JUDGE_K: "1",
    });
    expect(buildPromptfooEnv("run-123", { PROMPTFOO_DISABLE_UPDATE: "false" }).PROMPTFOO_DISABLE_UPDATE).toBe("false");
  });

  it("consumes harness tier and judge options without forwarding them to promptfoo", () => {
    const parsed = parseHarnessArgs([
      "--tier=smoke",
      "--judge-k",
      "1",
      "--filter-pattern",
      "Ask -",
    ]);
    expect(parsed).toEqual({
      tier: "smoke",
      tierExplicit: true,
      judgeK: 1,
      promptfooArgs: ["--filter-pattern", "Ask -"],
    });
    const args = buildPromptfooArgs("eval", parsed.promptfooArgs, { tier: parsed.tier, env: {} });
    expect(args.find((arg) => arg.endsWith("promptfooconfig.smoke.yaml"))).toBeDefined();
    expect(args).not.toContain("--tier=smoke");
    expect(args).not.toContain("--judge-k");
  });

  it("rejects missing or unknown modes", () => {
    expect(parseEvalMode("eval")).toBe("eval");
    expect(parseEvalMode("validate")).toBe("validate");
    expect(() => parseEvalMode(undefined)).toThrow(/expected eval mode/i);
    expect(() => parseEvalMode("watch")).toThrow(/expected eval mode/i);
    expect(() => parseHarnessArgs(["--tier", "quick"])).toThrow(/expected eval tier/i);
    expect(() => parseHarnessArgs(["--judge-k", "0"])).toThrow(/integer from 1 to 11/i);
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
