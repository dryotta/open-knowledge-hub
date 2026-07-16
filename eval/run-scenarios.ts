import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { cleanupEvalEnvironments } from "./environments.js";
import { terminateProcessTreeAndWait } from "./copilot.js";

/**
 * Runs the single default eval config (`eval/promptfooconfig.yaml`) in ONE
 * promptfoo process. The config pulls every case in via `scenarios:` (a
 * `file://scenarios/**\/*.yaml` glob) with a single `{{prompt}}` pass-through,
 * so promptfoo runs them concurrently with no prompt×test cross-product.
 *
 *   npm run eval          → `promptfoo eval -c eval/promptfooconfig.yaml --no-cache`
 *   npm run eval -- ARGS  → forwards ARGS to promptfoo (filters, repeats, concurrency)
 *   npm run eval:validate → `promptfoo validate -c eval/promptfooconfig.yaml`
 *
 * Invoked through `node --import tsx` so the TypeScript provider/assertions
 * load with NodeNext `.js` import specifiers.
 */
const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(EVAL_ROOT, "..");
const CONFIG = join(EVAL_ROOT, "promptfooconfig.yaml");
// Resolve through Node.js module resolution so the path works whether promptfoo
// lives in a local node_modules/ or in a parent directory (e.g. git worktrees).
// _require.resolve("promptfoo") returns the CJS entry (dist/src/index.cjs);
// entrypoint.js lives in the same directory.
const _require = createRequire(import.meta.url);
const PROMPTFOO = join(dirname(_require.resolve("promptfoo")), "entrypoint.js");
const SIGNAL_GRACE_MS = 5_000;
const DEFAULT_SCENARIO_CONCURRENCY = 2;

export type EvalMode = "eval" | "validate";

export function parseEvalMode(value: string | undefined): EvalMode {
  if (value === "eval" || value === "validate") return value;
  throw new Error(`expected eval mode "eval" or "validate", got ${JSON.stringify(value)}`);
}

export function buildPromptfooArgs(mode: EvalMode, extraArgs: string[] = []): string[] {
  const args = ["--import", "tsx", PROMPTFOO, mode, "-c", CONFIG];
  if (mode === "eval") {
    args.push("--no-cache");
    const hasConcurrencyOverride = extraArgs.some(
      (arg) => arg === "--max-concurrency" || arg.startsWith("--max-concurrency="),
    );
    if (!hasConcurrencyOverride) {
      args.push("--max-concurrency", String(DEFAULT_SCENARIO_CONCURRENCY));
    }
  }
  args.push(...extraArgs);
  return args;
}

export function buildPromptfooEnv(
  runId: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    OKH_EVAL_RUN_ID: runId,
    PROMPTFOO_DISABLE_UPDATE: base.PROMPTFOO_DISABLE_UPDATE ?? "true",
  };
}

export function resolvedExitCode(
  code: number | null,
  childSignal: NodeJS.Signals | null,
  requestedSignal?: NodeJS.Signals,
): number {
  const signal = requestedSignal ?? childSignal;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (code !== null) return code;
  return 1;
}

interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
}

interface LaunchPromptfooDeps {
  spawnProcess?: (
    command: string,
    args: string[],
    options: {
      stdio: "inherit";
      cwd: string;
      env: NodeJS.ProcessEnv;
      detached: boolean;
    },
  ) => ChildProcess;
  signalSource?: SignalSource;
  platform?: NodeJS.Platform;
  terminationGraceMs?: number;
  terminate?: (child: ChildProcess) => Promise<void>;
}

export function launchPromptfoo(
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: LaunchPromptfooDeps = {},
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const spawnProcess = deps.spawnProcess ?? spawn;
    const signalSource = deps.signalSource ?? {
      on: (signal, listener) => {
        process.on(signal, listener);
      },
      off: (signal, listener) => {
        process.off(signal, listener);
      },
    };
    const platform = deps.platform ?? process.platform;
    const terminationGraceMs = deps.terminationGraceMs ?? SIGNAL_GRACE_MS;
    const terminate = deps.terminate ?? terminateProcessTreeAndWait;
    let child: ChildProcess;
    try {
      child = spawnProcess(process.execPath, args, {
        stdio: "inherit",
        cwd: REPO_ROOT,
        env,
        detached: platform !== "win32",
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    let settled = false;
    let requestedSignal: NodeJS.Signals | undefined;
    let signalCount = 0;
    let termination: Promise<void> | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;
    const forceTerminate = (): void => {
      if (termination) return;
      termination = terminate(child);
      void termination.then(
        () => settle(() => resolvePromise(
          resolvedExitCode(child.exitCode, child.signalCode, requestedSignal),
        )),
        (error) => settle(() => rejectPromise(error)),
      );
    };
    const forwardSignal = (signal: NodeJS.Signals): void => {
      requestedSignal ??= signal;
      signalCount++;

      if (platform === "win32" || signalCount > 1) {
        forceTerminate();
        return;
      }
      if (
        (child.exitCode === null && child.signalCode === null && !child.kill(signal))
        || child.exitCode !== null
        || child.signalCode !== null
      ) {
        forceTerminate();
        return;
      }
      escalationTimer = setTimeout(forceTerminate, terminationGraceMs);
    };
    const onSigint = (): void => forwardSignal("SIGINT");
    const onSigterm = (): void => forwardSignal("SIGTERM");
    const removeSignalHandlers = (): void => {
      signalSource.off("SIGINT", onSigint);
      signalSource.off("SIGTERM", onSigterm);
      if (escalationTimer) clearTimeout(escalationTimer);
    };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      removeSignalHandlers();
      callback();
    };

    signalSource.on("SIGINT", onSigint);
    signalSource.on("SIGTERM", onSigterm);
    child.once("error", (error) => settle(() => rejectPromise(error)));
    child.once("close", (code, signal) => {
      void (async () => {
        await termination;
        settle(() => resolvePromise(resolvedExitCode(code, signal, requestedSignal)));
      })();
    });
  });
}

export async function runPromptfoo(mode: EvalMode, extraArgs: string[] = []): Promise<number> {
  const runId = randomUUID();
  let runError: unknown;
  let code: number | undefined;
  try {
    code = await launchPromptfoo(buildPromptfooArgs(mode, extraArgs), buildPromptfooEnv(runId));
  } catch (error) {
    runError = error;
  }

  let cleanupError: unknown;
  if (mode === "eval" && process.env.OKH_EVAL_KEEP_WORKSPACES !== "1") {
    try {
      await cleanupEvalEnvironments(runId);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (runError && cleanupError) {
    throw new AggregateError([runError, cleanupError], "promptfoo eval and workspace cleanup both failed");
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;
  return code ?? 1;
}

const MODULE_PATH = fileURLToPath(import.meta.url);
const invokedDirectly = !!process.argv[1] && resolve(process.argv[1]) === MODULE_PATH;

if (invokedDirectly) {
  let mode: EvalMode | undefined;
  try {
    mode = parseEvalMode(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }

  if (mode) {
    runPromptfoo(mode, process.argv.slice(3))
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
