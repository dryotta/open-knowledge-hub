import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

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

/**
 * Default single-shot runner: spawns `copilot -p ... --allow-all [--model M]`,
 * captures stdout+stderr as text. Used by the judge for grading calls.
 */
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

const OKH_SERVER = "open-knowledge-hub";

export interface ParsedTurn {
  /** Assistant spoken messages this turn (no tool lines) — used for guard matching. */
  messages: string[];
  lastMessage: string;
  tools: string[];
  cost: number;
  sessionId: string | null;
  code: number | null;
  /** Human-readable turn transcript interleaving messages + tool calls/results (for the judge). */
  render: string;
}

interface ToolRequest {
  mcpServerName?: string;
  mcpToolName?: string;
}
interface EventData {
  content?: string;
  toolRequests?: ToolRequest[];
  mcpServerName?: string;
  mcpToolName?: string;
  toolCallId?: string;
  toolName?: string;
  arguments?: unknown;
  success?: boolean;
  result?: { content?: string; detailedContent?: string };
  sessionId?: string;
  exitCode?: number;
  usage?: { premiumRequests?: number };
}
interface CopilotEvent {
  type?: string;
  data?: EventData;
  sessionId?: string;
  exitCode?: number;
  usage?: { premiumRequests?: number };
}

/**
 * Parse Copilot CLI `--output-format json` (JSONL) from one turn: assistant
 * message contents, OKH MCP tool names (from `toolRequests[]` and
 * `tool.execution_start`, keyed on `mcpServerName === "open-knowledge-hub"`),
 * the final `result` event's sessionId / exitCode / cumulative cost, and a
 * human-readable `render` interleaving messages with tool calls + results (in
 * event order) so the judge sees what the agent *did*, not just what it said.
 */
export function parseCopilotEvents(jsonl: string): ParsedTurn {
  const messages: string[] = [];
  const tools = new Set<string>();
  const parts: string[] = [];
  const toolLabel = new Map<string, string>();
  let cost = 0;
  let sessionId: string | null = null;
  let code: number | null = null;

  const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

  for (const raw of jsonl.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t.startsWith("{")) continue;
    let e: CopilotEvent;
    try {
      e = JSON.parse(t) as CopilotEvent;
    } catch {
      continue;
    }
    const d = e.data ?? {};
    switch (e.type) {
      case "assistant.message": {
        if (typeof d.content === "string" && d.content.trim()) {
          messages.push(d.content);
          parts.push(d.content);
        }
        for (const r of d.toolRequests ?? []) {
          if (r?.mcpServerName === OKH_SERVER && typeof r.mcpToolName === "string") tools.add(r.mcpToolName);
        }
        break;
      }
      case "tool.execution_start": {
        const label = d.mcpServerName ? `${d.mcpServerName}:${d.mcpToolName}` : (d.toolName ?? "tool");
        if (d.toolCallId) toolLabel.set(d.toolCallId, label);
        if (d.mcpServerName === OKH_SERVER && typeof d.mcpToolName === "string") tools.add(d.mcpToolName);
        const args = d.arguments !== undefined ? truncate(JSON.stringify(d.arguments), 200) : "";
        parts.push(`→ tool: ${label}${args && args !== "{}" ? ` ${args}` : ""}`);
        break;
      }
      case "tool.execution_complete": {
        const label = (d.toolCallId && toolLabel.get(d.toolCallId)) || "tool";
        const res = typeof d.result?.content === "string" ? d.result.content : d.result?.detailedContent ?? "";
        parts.push(`← ${label}${d.success === false ? " [error]" : ""}: ${truncate(res.replace(/\s+/g, " "), 300)}`);
        break;
      }
      case "result": {
        sessionId = e.sessionId ?? d.sessionId ?? null;
        const pr = e.usage?.premiumRequests ?? d.usage?.premiumRequests;
        if (typeof pr === "number") cost = pr;
        const ec = e.exitCode ?? d.exitCode;
        if (typeof ec === "number") code = ec;
        break;
      }
    }
  }
  return {
    messages,
    lastMessage: messages.at(-1) ?? "",
    tools: [...tools].sort(),
    cost,
    sessionId,
    code,
    render: parts.join("\n"),
  };
}

export interface CopilotTurnOptions {
  /** The user message for THIS turn. */
  prompt: string;
  /** Session UUID we control; created on turn 1, resumed afterwards. */
  sessionId: string;
  /** false → `--session-id` (create); true → `--resume=` (continue). */
  resume: boolean;
  model?: string;
  copilotHome: string;
  cwd: string;
  timeoutMs?: number;
  /** Extra env merged over process.env (e.g. tokens). */
  extraEnv?: NodeJS.ProcessEnv;
}

export interface CopilotTurnResult extends ParsedTurn {
  /** Raw JSONL for debugging. */
  raw: string;
}

/** Injectable so tests never spawn the real `copilot`. */
export type CopilotTurnRunner = (opts: CopilotTurnOptions) => Promise<CopilotTurnResult>;

/** Default turn runner: spawns `copilot -p ... --output-format json`, parsing one turn. */
export const spawnCopilotTurn: CopilotTurnRunner = (opts) =>
  new Promise((resolve) => {
    const args = ["-p", opts.prompt, "--allow-all", "--output-format", "json", "--no-color"];
    if (opts.resume) args.push(`--resume=${opts.sessionId}`);
    else args.push("--session-id", opts.sessionId);
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
      const parsed = parseCopilotEvents(out);
      resolve({ ...parsed, raw: out, code: parsed.code ?? code });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      const parsed = parseCopilotEvents(out);
      resolve({ ...parsed, raw: `${out}\n[spawn error] ${(err as Error).message}`, code: null });
    });
  });

export interface Turn {
  /** The user message to send. */
  send: string;
  /** Optional case-insensitive regex matched against the agent's last message. */
  when?: string;
}

export interface ConversationScript {
  /** Turn 1 user message (the promptfoo `{{prompt}}`). */
  initial: string;
  /** Guarded follow-up user messages. */
  responses: Turn[];
  /** Safety cap on total turns. Default: responses.length + 2. */
  maxTurns?: number;
}

export interface ConversationTurn {
  user: string;
  agent: string;
  tools: string[];
}

export interface ConversationResult {
  /** Aggregated, human-readable transcript (fed to the judge + transcript asserts). */
  transcript: string;
  /** Union of OKH tools called across all turns, sorted. */
  toolCalls: string[];
  turns: ConversationTurn[];
  /** Last turn's cumulative premiumRequests (== whole-conversation cost). */
  cost: number;
  /** Last turn's exit code. */
  code: number | null;
}

export interface RunConversationCtx {
  runner: CopilotTurnRunner;
  model?: string;
  copilotHome: string;
  cwd: string;
  timeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
}

function safeMatch(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false;
  }
}

/** Choose the next unsent response: a guard that matches the agent wins; else the first unguarded; else -1. */
function selectNext(responses: Turn[], sent: boolean[], lastAgent: string): number {
  for (let i = 0; i < responses.length; i++) {
    if (sent[i]) continue;
    const w = responses[i]!.when;
    if (w && safeMatch(w, lastAgent)) return i;
  }
  for (let i = 0; i < responses.length; i++) {
    if (!sent[i] && !responses[i]!.when) return i;
  }
  return -1;
}

/**
 * Drive a multi-turn Copilot CLI conversation over one resumed session. Turn 1
 * sends `initial`; after each turn the next scripted user message is picked by
 * guard match (falling back to declared order), until no response is eligible,
 * a turn errors, or `maxTurns` is reached.
 */
export async function runConversation(script: ConversationScript, ctx: RunConversationCtx): Promise<ConversationResult> {
  const sessionId = randomUUID();
  const responses = script.responses ?? [];
  const maxTurns = script.maxTurns ?? responses.length + 2;
  const sent = responses.map(() => false);
  const turns: ConversationTurn[] = [];
  const toolSet = new Set<string>();
  let cost = 0;
  let code: number | null = null;

  const runTurn = async (user: string, resume: boolean): Promise<CopilotTurnResult> => {
    const r = await ctx.runner({
      prompt: user,
      sessionId,
      resume,
      model: ctx.model,
      copilotHome: ctx.copilotHome,
      cwd: ctx.cwd,
      timeoutMs: ctx.timeoutMs,
      extraEnv: ctx.extraEnv,
    });
    turns.push({ user, agent: r.render || r.messages.join("\n"), tools: r.tools });
    for (const t of r.tools) toolSet.add(t);
    if (r.cost) cost = r.cost;
    code = r.code;
    return r;
  };

  let last = await runTurn(script.initial, false);
  while (turns.length < maxTurns) {
    if (last.code !== 0) break;
    const idx = selectNext(responses, sent, last.lastMessage);
    if (idx < 0) break;
    sent[idx] = true;
    last = await runTurn(responses[idx]!.send, true);
  }

  const transcript = turns
    .map((t, i) => `=== USER (turn ${i + 1}) ===\n${t.user}\n\n=== AGENT (turn ${i + 1}) ===\n${t.agent}`)
    .join("\n\n");

  return { transcript, toolCalls: [...toolSet].sort(), turns, cost, code };
}
