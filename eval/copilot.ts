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
export function buildJudgeCopilotArgs(prompt: string, model?: string): string[] {
  const args = [
    "-p",
    prompt,
    "--allow-all",
    "--available-tools=",
    "--silent",
    "--no-color",
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    "--no-remote-export",
    "--no-auto-update",
  ];
  if (model) args.push("--model", model);
  return args;
}

export const spawnCopilot: CopilotRunner = (opts) =>
  new Promise((resolve) => {
    const args = buildJudgeCopilotArgs(opts.prompt, opts.model);
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

export interface ToolEvent {
  turn: number;
  callId: string;
  server: string;
  tool: string;
  arguments: unknown;
  completed: boolean;
  success: boolean;
}

export interface ParsedTurn {
  /** Assistant spoken messages this turn (no tool lines) — used for guard matching. */
  messages: string[];
  lastMessage: string;
  tools: string[];
  toolEvents: ToolEvent[];
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
 * message contents, OKH MCP tool names (from completed+successful
 * `tool.execution_complete` events keyed on `mcpServerName === "open-knowledge-hub"`),
 * the final `result` event's sessionId / exitCode / cumulative cost, and a
 * human-readable `render` interleaving messages with tool calls + results (in
 * event order) so the judge sees what the agent *did*, not just what it said.
 */
export function parseCopilotEvents(jsonl: string, turn = 1): ParsedTurn {
  const messages: string[] = [];
  const parts: string[] = [];
  const toolLabel = new Map<string, string>();
  const toolEventMap = new Map<string, ToolEvent>();
  const toolEvents: ToolEvent[] = [];
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
        break;
      }
      case "tool.execution_start": {
        const server = d.mcpServerName ?? "";
        const tool = d.mcpToolName ?? d.toolName ?? "tool";
        const label = server ? `${server}:${tool}` : tool;
        const callId = d.toolCallId ?? `synthetic-${toolEvents.length}`;
        if (d.toolCallId) toolLabel.set(d.toolCallId, label);
        const ev: ToolEvent = { turn, callId, server, tool, arguments: d.arguments, completed: false, success: false };
        toolEvents.push(ev);
        if (d.toolCallId) toolEventMap.set(d.toolCallId, ev);
        const args = d.arguments !== undefined ? truncate(JSON.stringify(d.arguments), 200) : "";
        parts.push(`→ tool: ${label}${args && args !== "{}" ? ` ${args}` : ""}`);
        break;
      }
      case "tool.execution_complete": {
        const label = (d.toolCallId && toolLabel.get(d.toolCallId)) || "tool";
        if (d.toolCallId) {
          const ev = toolEventMap.get(d.toolCallId);
          if (ev) {
            ev.completed = true;
            ev.success = d.success === true;
          }
        }
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

  const tools = [
    ...new Set(
      toolEvents
        .filter((ev) => ev.completed && ev.success && ev.server === OKH_SERVER)
        .map((ev) => ev.tool),
    ),
  ].sort();

  return {
    messages,
    lastMessage: messages.at(-1) ?? "",
    tools,
    toolEvents,
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
  /** 1-based turn index within the conversation; set by runConversation. */
  turn?: number;
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
      const parsed = parseCopilotEvents(out, opts.turn ?? 1);
      resolve({ ...parsed, raw: out, code: parsed.code ?? code });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      const parsed = parseCopilotEvents(out, opts.turn ?? 1);
      resolve({ ...parsed, raw: `${out}\n[spawn error] ${(err as Error).message}`, code: null });
    });
  });

export interface Turn {
  /** Unique identifier for this turn (becomes the state after selection). */
  id: string;
  /** Predecessor state(s) from which this turn is eligible. */
  after: string | string[];
  /** The user message to send. */
  send: string;
  /** Optional case-insensitive regex matched against the latest agent message. */
  when?: string;
}

export interface ConversationTerminal {
  /** The state after which the conversation is considered complete. */
  after: string;
  /** OKH tools that must have been successfully called before completion. */
  requiredTools?: string[];
}

export interface ConversationScript {
  /** Turn 1 user message (the promptfoo `{{prompt}}`). */
  initial: string;
  /** Guarded follow-up user messages with state machine annotations. */
  responses: Turn[];
  /** Terminal condition for conversation completion. */
  terminal?: ConversationTerminal;
  /** Safety cap on total turns. Default: responses.length + 2. */
  maxTurns?: number;
}

export interface ConversationTurn {
  user: string;
  agent: string;
  tools: string[];
  toolEvents: ToolEvent[];
}

export interface ConversationResult {
  /** Aggregated, human-readable transcript (fed to the judge + transcript asserts). */
  transcript: string;
  /** Union of OKH tools called across all turns, sorted. */
  toolCalls: string[];
  turns: ConversationTurn[];
  toolEvents: ToolEvent[];
  /** Last turn's cumulative premiumRequests (== whole-conversation cost). */
  cost: number;
  /** Last turn's exit code. */
  code: number | null;
  /** If set, the conversation ended in a state-machine failure. */
  failure?: string;
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

/** Check if a turn's `after` includes the given state. */
function isEligible(turn: Turn, state: string): boolean {
  const afters = Array.isArray(turn.after) ? turn.after : [turn.after];
  return afters.includes(state);
}

/** Choose the next unsent response using the state machine: only turns whose `after` includes `state` are eligible. */
function selectNext(responses: Turn[], sent: boolean[], state: string, lastAgent: string): number {
  // First pass: guarded turns eligible from current state whose `when` matches
  for (let i = 0; i < responses.length; i++) {
    if (sent[i]) continue;
    if (!isEligible(responses[i]!, state)) continue;
    const w = responses[i]!.when;
    if (w && safeMatch(w, lastAgent)) return i;
  }
  // Second pass: unguarded turns (no `when`) eligible from current state
  for (let i = 0; i < responses.length; i++) {
    if (sent[i]) continue;
    if (!isEligible(responses[i]!, state)) continue;
    if (!responses[i]!.when) return i;
  }
  return -1;
}

/**
 * Drive a multi-turn Copilot CLI conversation over one resumed session.
 * Uses a state machine: initial state is "start"; selecting a turn advances
 * state to turn.id. Terminal condition checked after each agent turn.
 */
export async function runConversation(script: ConversationScript, ctx: RunConversationCtx): Promise<ConversationResult> {
  const sessionId = randomUUID();
  const responses = script.responses ?? [];
  const maxTurns = script.maxTurns ?? responses.length + 2;
  const sent = responses.map(() => false);
  const turns: ConversationTurn[] = [];
  const allToolEvents: ToolEvent[] = [];
  const toolSet = new Set<string>();
  let cost = 0;
  let code: number | null = null;
  let state = "start";
  let failure: string | undefined;

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
      turn: turns.length + 1,
    });
    turns.push({ user, agent: r.render || r.messages.join("\n"), tools: r.tools, toolEvents: r.toolEvents });
    for (const ev of r.toolEvents) {
      allToolEvents.push(ev);
      if (ev.completed && ev.success && ev.server === OKH_SERVER) toolSet.add(ev.tool);
    }
    if (r.cost) cost = r.cost;
    code = r.code;
    return r;
  };

  const buildResult = (): ConversationResult => {
    const transcript = turns
      .map((t, i) => `=== USER (turn ${i + 1}) ===\n${t.user}\n\n=== AGENT (turn ${i + 1}) ===\n${t.agent}`)
      .join("\n\n");
    return { transcript, toolCalls: [...toolSet].sort(), turns, toolEvents: allToolEvents, cost, code, ...(failure ? { failure } : {}) };
  };

  // Check terminal readiness
  const checkTerminal = (): boolean => {
    if (!script.terminal) return false;
    if (state !== script.terminal.after) return false;
    if (script.terminal.requiredTools) {
      const missing = script.terminal.requiredTools.filter((t) => !toolSet.has(t));
      if (missing.length > 0) {
        failure = `terminal state "${state}" reached but required tools missing: ${missing.join(", ")}`;
        return true; // stop the loop (failure is set)
      }
    }
    return true; // terminal reached successfully
  };

  let last = await runTurn(script.initial, false);

  // Single-turn scripts with no responses: complete after turn 1
  if (responses.length === 0) return buildResult();

  while (turns.length < maxTurns) {
    if (last.code !== 0) break;

    // Check terminal after each agent turn
    if (checkTerminal()) break;

    // Select next turn based on state machine
    const idx = selectNext(responses, sent, state, last.lastMessage);
    if (idx < 0) {
      // No eligible guard matches — explicit failure
      const snippet = last.lastMessage ? last.lastMessage.slice(0, 120) : "(no agent message)";
      failure = `unmatched conversation state "${state}": ${snippet}`;
      break;
    }
    sent[idx] = true;
    state = responses[idx]!.id;
    last = await runTurn(responses[idx]!.send, true);
  }

  // After loop: check if we stopped due to maxTurns without reaching terminal
  if (!failure && last.code === 0 && script.terminal && state !== script.terminal.after) {
    failure = `max turns (${maxTurns}) exhausted without reaching terminal state "${script.terminal.after}"`;
  }
  // Check terminal tool requirements at the end if we reached terminal state
  if (!failure && last.code === 0 && script.terminal && state === script.terminal.after && script.terminal.requiredTools) {
    const missing = script.terminal.requiredTools.filter((t) => !toolSet.has(t));
    if (missing.length > 0) {
      failure = `terminal state "${state}" reached but required tools missing: ${missing.join(", ")}`;
    }
  }

  return buildResult();
}
