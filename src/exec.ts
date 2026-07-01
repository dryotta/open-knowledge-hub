import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Extra environment variables merged over the current process env. */
  env?: NodeJS.ProcessEnv;
  /** Max buffer for stdout/stderr in bytes (default 32 MiB). */
  maxBuffer?: number;
}

/**
 * Error thrown when a spawned command exits non-zero.
 * Carries the command, exit code, and captured output for diagnostics.
 */
export class CommandError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    command: string,
    args: readonly string[],
    exitCode: number | null,
    stdout: string,
    stderr: string,
  ) {
    super(
      `Command failed (${exitCode ?? "signal"}): ${command} ${args.join(" ")}\n${stderr.trim() || stdout.trim()}`,
    );
    this.name = "CommandError";
    this.command = command;
    this.args = args;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * Promisified `execFile` that never uses a shell (arguments are passed as an
 * array, so there is no shell-injection surface). Rejects with {@link CommandError}
 * on non-zero exit.
 *
 * This is the single choke point through which all `git`/`gh` invocations flow,
 * which keeps process spawning testable and injectable.
 */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args as string[],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode =
            typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
              ? ((error as unknown as { code: number }).code)
              : null;
          reject(new CommandError(command, args, exitCode, stdout, stderr));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/** The signature of {@link run}; used to inject a fake runner in unit tests. */
export type Runner = typeof run;
