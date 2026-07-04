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

const OKH_TOOLS = ["inspect", "add", "sync", "onboard", "config", "ask", "context", "learn", "remember", "reflect"] as const;

/**
 * Extract which OKH tools were invoked, from the transcript.
 *
 * Primary signal (verified against a real Copilot CLI run): each MCP tool call is
 * rendered on a line containing `(MCP: open-knowledge-hub)` with the tool's title,
 * e.g. `● Remember (flow) (MCP: open-knowledge-hub) · container: ...` or
 * `● Sync containers (MCP: open-knowledge-hub) · ...`. We match the OKH tool name
 * as a word against the tool title only — the text before `(MCP:` — so argument
 * names that collide with tool names (e.g. add's `config`/`sync` arguments, which
 * appear after the `·` separator) don't spoof a tool call. A server-qualified
 * fallback (`open-knowledge-hub<sep>TOOL`) covers other renderings/versions.
 */
export function extractToolCalls(transcript: string): string[] {
  const found = new Set<string>();
  for (const line of transcript.split(/\r?\n/)) {
    const mcp = line.search(/\(MCP:\s*open-knowledge-hub\)/i);
    if (mcp < 0) continue;
    const title = line.slice(0, mcp);
    for (const t of OKH_TOOLS) {
      if (new RegExp(`\\b${t}\\b`, "i").test(title)) found.add(t);
    }
  }
  for (const t of OKH_TOOLS) {
    if (new RegExp(`open-knowledge-hub[^a-z0-9]{1,4}${t}\\b`, "i").test(transcript)) found.add(t);
  }
  return [...found].sort();
}
