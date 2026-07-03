import { spawn } from "node:child_process";

export interface CopilotRunOptions {
  prompt: string;
  model?: string;
  copilotHome: string;
  cwd: string;
  timeoutMs?: number;
  /** Extra env merged over process.env (e.g. tokens). */
  extraEnv?: NodeJS.ProcessEnv;
}

export interface CopilotResult {
  transcript: string;
  code: number | null;
}

/** Injectable so tests never spawn the real `copilot`. */
export type CopilotRunner = (opts: CopilotRunOptions) => Promise<CopilotResult>;

/** Default runner: spawns `copilot -p ... --allow-all [--model M]`, captures stdout+stderr. */
export const spawnCopilot: CopilotRunner = (opts) =>
  new Promise((resolve) => {
    const args = ["-p", opts.prompt, "--allow-all"];
    if (opts.model) args.push("--model", opts.model);
    const child = spawn("copilot", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.extraEnv, COPILOT_HOME: opts.copilotHome },
      shell: false,
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ transcript: out, code });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ transcript: `${out}\n[spawn error] ${(err as Error).message}`, code: null });
    });
  });

const OKH_TOOLS = ["inspect", "add", "sync", "ask", "context", "learn", "remember", "reflect"] as const;

/**
 * Best-effort extraction of which OKH tools were invoked, from the transcript.
 * Matches a server-qualified reference (`open-knowledge-hub<sep>TOOL`) or a
 * parenthesized call (`TOOL(`). The exact Copilot CLI tool-call rendering is a
 * verify-point (Task 8); this parser is tolerant and unit-tested.
 */
export function extractToolCalls(transcript: string): string[] {
  const found = new Set<string>();
  for (const t of OKH_TOOLS) {
    const qualified = new RegExp(`open-knowledge-hub[^a-z0-9]{1,4}${t}\\b`, "i");
    const called = new RegExp(`\\b${t}\\s*\\(`, "i");
    if (qualified.test(transcript) || called.test(transcript)) found.add(t);
  }
  return [...found].sort();
}
