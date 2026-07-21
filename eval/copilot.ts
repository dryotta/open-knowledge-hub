import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const TERMINATION_GRACE_MS = 5_000;

export interface CopilotRunOptions {
  prompt: string;
  model?: string;
  copilotHome: string;
  cwd: string;
  timeoutMs?: number;
  /** Extra env merged over process.env (e.g. tokens). */
  extraEnv?: NodeJS.ProcessEnv;
  /** Load instructions from the isolated working directory. */
  loadCustomInstructions?: boolean;
  abortSignal?: AbortSignal;
}

export interface CopilotResult {
  transcript: string;
  code: number | null;
  /** Explicit spawn/timeout/abort diagnostic when the process did not exit normally. */
  processFailure?: string;
  processFailureKind?: ProcessFailureKind;
}

/** Injectable so tests never spawn the real `copilot`. */
export type CopilotRunner = (opts: CopilotRunOptions) => Promise<CopilotResult>;

/** Force-stop a child and its descendants. */
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("close", (code) => {
        if (code !== 0 && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        resolve();
      });
      killer.once("error", () => {
        child.kill("SIGKILL");
        resolve();
      });
    });
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

export type TerminationReason = "timeout" | "abort";
export type ProcessFailureKind = TerminationReason | "spawn" | "signal";

export function resolvedProcessExitCode(
  parsedCode: number | null | undefined,
  childCode: number | null,
  processFailure?: string,
): number | null {
  if (processFailure) return null;
  if (childCode !== null && childCode !== 0) return childCode;
  return parsedCode ?? childCode;
}

function streamsClosed(child: ChildProcess): boolean {
  return [child.stdin, child.stdout, child.stderr].every(
    (stream) => stream === null || stream.destroyed || ("closed" in stream && stream.closed),
  );
}

/** Kill a process tree and wait for stdio closure, but never beyond the grace period. */
export async function terminateProcessTreeAndWait(
  child: ChildProcess,
  graceMs = TERMINATION_GRACE_MS,
): Promise<void> {
  if ((child.exitCode !== null || child.signalCode !== null) && streamsClosed(child)) return;

  let closed = false;
  let resolveClose!: () => void;
  const closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const onClose = (): void => {
    closed = true;
    resolveClose();
  };
  child.once("close", onClose);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all([terminateProcessTree(child), closePromise]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    child.off("close", onClose);
    if (!closed) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      void terminateProcessTree(child);
    }
  }
}

export function attachTermination(
  child: ChildProcess,
  timeoutMs: number | undefined,
  abortSignal: AbortSignal | undefined,
  onStopped?: (reason: TerminationReason) => void,
  onStopping?: (reason: TerminationReason) => void,
): () => void {
  let stopping = false;
  const stop = (reason: TerminationReason): void => {
    if (stopping) return;
    stopping = true;
    onStopping?.(reason);
    void terminateProcessTreeAndWait(child).finally(() => onStopped?.(reason));
  };
  const timer = timeoutMs ? setTimeout(() => stop("timeout"), timeoutMs) : undefined;
  const onAbort = (): void => stop("abort");
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (abortSignal?.aborted) stop("abort");

  return () => {
    if (timer) clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
  };
}

function terminationDiagnostic(
  subject: "judge" | "Copilot turn",
  reason: TerminationReason,
  timeoutMs: number | undefined,
): string {
  if (reason === "timeout") {
    return `[${subject} timed out after ${timeoutMs ?? "unknown"}ms]`;
  }
  return `[${subject} aborted]`;
}

/**
 * Default single-shot runner: spawns `copilot -p ... --allow-all [--model M]`,
 * captures stdout+stderr as text. Used by the judge for grading calls.
 */
export function buildJudgeCopilotArgs(
  prompt: string,
  model?: string,
  loadCustomInstructions = false,
): string[] {
  const args = [
    "-p",
    prompt,
    "--allow-all",
    "--available-tools=",
    "--silent",
    "--no-color",
  ];
  if (!loadCustomInstructions) args.push("--no-custom-instructions");
  args.push(
    "--disable-builtin-mcps",
    "--no-remote-export",
    "--no-auto-update",
  );
  if (model) args.push("--model", model);
  return args;
}

export const spawnCopilot: CopilotRunner = (opts) =>
  new Promise((resolve) => {
    if (opts.abortSignal?.aborted) {
      resolve({
        transcript: "[aborted before judge process started]",
        code: null,
        processFailure: "[judge aborted before process started]",
        processFailureKind: "abort",
      });
      return;
    }
    const args = buildJudgeCopilotArgs(
      opts.prompt,
      opts.model,
      opts.loadCustomInstructions,
    );
    const child = spawn("copilot", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.extraEnv, COPILOT_HOME: opts.copilotHome },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let out = "";
    let settled = false;
    let processFailureKind: ProcessFailureKind | undefined;
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    let detachTermination = (): void => {};
    const finish = (code: number | null, diagnostic?: string): void => {
      if (settled) return;
      settled = true;
      detachTermination();
      resolve({
        transcript: diagnostic ? `${out}\n${diagnostic}` : out,
        code: resolvedProcessExitCode(undefined, code, diagnostic),
        ...(diagnostic ? { processFailure: diagnostic } : {}),
        ...(processFailureKind ? { processFailureKind } : {}),
      });
    };
    detachTermination = attachTermination(
      child,
      opts.timeoutMs,
      opts.abortSignal,
      (reason) => finish(null, terminationDiagnostic("judge", reason, opts.timeoutMs)),
      (reason) => {
        processFailureKind = reason;
      },
    );
    child.on("close", (code, signal) => {
      const reason = processFailureKind === "timeout" || processFailureKind === "abort"
        ? processFailureKind
        : undefined;
      if (!reason && signal) {
        processFailureKind = "signal";
        finish(null, `[judge exited from signal ${signal}]`);
        return;
      }
      finish(
        reason ? null : code,
        reason ? terminationDiagnostic("judge", reason, opts.timeoutMs) : undefined,
      );
    });
    child.on("error", (err) => {
      processFailureKind = "spawn";
      finish(null, `[spawn error] ${(err as Error).message}`);
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
  /** JSONL event sequence at tool start, rebased across turns after aggregation. */
  startSequence?: number;
  /** JSONL event sequence at tool completion, rebased across turns after aggregation. */
  completionSequence?: number;
  /** Captured completion text for deterministic provenance assertions. */
  result?: string;
}

export interface ParsedTurn {
  /** Assistant spoken messages this turn (no tool lines) — used for guard matching. */
  messages: string[];
  lastMessage: string;
  tools: string[];
  /** Ordered tool events (all servers) with untruncated arguments for deterministic assertions. */
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
  let eventSequence = 0;

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
    eventSequence += 1;
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
        const ev: ToolEvent = {
          turn,
          callId,
          server,
          tool,
          arguments: d.arguments,
          completed: false,
          success: false,
          startSequence: eventSequence,
        };
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
            ev.completionSequence = eventSequence;
            const result = typeof d.result?.content === "string"
              ? d.result.content
              : d.result?.detailedContent;
            if (typeof result === "string") ev.result = result;
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
  abortSignal?: AbortSignal;
  /** 1-based turn index within the conversation; set by runConversation. */
  turn?: number;
}

export interface CopilotTurnResult extends ParsedTurn {
  /** Raw JSONL for debugging. */
  raw: string;
  timings?: TurnTimings;
  /** Explicit spawn/timeout/abort diagnostic when the process did not exit normally. */
  processFailure?: string;
  processFailureKind?: ProcessFailureKind;
}

export interface TurnTimings {
  totalMs: number;
  agentMs: number;
  toolMs: number;
}

export class ToolTimingTracker {
  private buffer = "";
  private readonly active = new Set<string>();
  private activeSince: number | undefined;
  private elapsedMs = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.observe(line, this.now());
      newline = this.buffer.indexOf("\n");
    }
  }

  finish(atMs = this.now()): number {
    if (this.buffer) {
      this.observe(this.buffer, atMs);
      this.buffer = "";
    }
    if (this.activeSince !== undefined) {
      this.elapsedMs += Math.max(0, atMs - this.activeSince);
      this.activeSince = undefined;
      this.active.clear();
    }
    return this.elapsedMs;
  }

  private observe(raw: string, atMs: number): void {
    const line = raw.trim();
    if (!line.startsWith("{")) return;
    let event: CopilotEvent;
    try {
      event = JSON.parse(line) as CopilotEvent;
    } catch {
      return;
    }
    const callId = event.data?.toolCallId;
    if (!callId) return;
    if (event.type === "tool.execution_start" && !this.active.has(callId)) {
      if (this.active.size === 0) this.activeSince = atMs;
      this.active.add(callId);
    } else if (event.type === "tool.execution_complete" && this.active.delete(callId) && this.active.size === 0) {
      this.elapsedMs += Math.max(0, atMs - (this.activeSince ?? atMs));
      this.activeSince = undefined;
    }
  }
}

/** Injectable so tests never spawn the real `copilot`. */
export type CopilotTurnRunner = (opts: CopilotTurnOptions) => Promise<CopilotTurnResult>;

export function buildCopilotTurnArgs(opts: Pick<CopilotTurnOptions, "prompt" | "sessionId" | "resume" | "model">): string[] {
  const args = [
    "-p",
    opts.prompt,
    "--allow-all",
    "--output-format",
    "json",
    "--no-color",
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    "--no-remote-export",
    "--no-auto-update",
  ];
  if (opts.resume) args.push(`--resume=${opts.sessionId}`);
  else args.push("--session-id", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
  return args;
}

/** Default turn runner: spawns `copilot -p ... --output-format json`, parsing one turn. */
export const spawnCopilotTurn: CopilotTurnRunner = (opts) =>
  new Promise((resolve) => {
    const startedAt = performance.now();
    if (opts.abortSignal?.aborted) {
      const parsed = parseCopilotEvents("", opts.turn ?? 1);
      resolve({
        ...parsed,
        raw: "[aborted before Copilot turn started]",
        code: null,
        timings: { totalMs: 0, agentMs: 0, toolMs: 0 },
        processFailure: "[Copilot turn aborted before process started]",
        processFailureKind: "abort",
      });
      return;
    }
    const args = buildCopilotTurnArgs(opts);
    const child = spawn("copilot", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.extraEnv, COPILOT_HOME: opts.copilotHome },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let out = "";
    let settled = false;
    let processFailureKind: ProcessFailureKind | undefined;
    const toolTiming = new ToolTimingTracker();
    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      out += chunk;
      toolTiming.push(chunk);
    });
    child.stderr.on("data", (d) => (out += d.toString()));
    let detachTermination = (): void => {};
    const finish = (code: number | null, diagnostic?: string): void => {
      if (settled) return;
      settled = true;
      detachTermination();
      const finishedAt = performance.now();
      const totalMs = Math.max(0, finishedAt - startedAt);
      const toolMs = Math.min(totalMs, toolTiming.finish(finishedAt));
      const parsed = parseCopilotEvents(out, opts.turn ?? 1);
      resolve({
        ...parsed,
        raw: diagnostic ? `${out}\n${diagnostic}` : out,
        code: resolvedProcessExitCode(parsed.code, code, diagnostic),
        timings: { totalMs, agentMs: totalMs - toolMs, toolMs },
        ...(diagnostic ? { processFailure: diagnostic } : {}),
        ...(processFailureKind ? { processFailureKind } : {}),
      });
    };
    detachTermination = attachTermination(
      child,
      opts.timeoutMs,
      opts.abortSignal,
      (reason) => finish(null, terminationDiagnostic("Copilot turn", reason, opts.timeoutMs)),
      (reason) => {
        processFailureKind = reason;
      },
    );
    child.on("close", (code, signal) => {
      const reason = processFailureKind === "timeout" || processFailureKind === "abort"
        ? processFailureKind
        : undefined;
      if (!reason && signal) {
        processFailureKind = "signal";
        finish(null, `[Copilot turn exited from signal ${signal}]`);
        return;
      }
      finish(
        reason ? null : code,
        reason ? terminationDiagnostic("Copilot turn", reason, opts.timeoutMs) : undefined,
      );
    });
    child.on("error", (err) => {
      processFailureKind = "spawn";
      finish(null, `[spawn error] ${(err as Error).message}`);
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
  /** Successful OKH tool that must end the terminal turn. */
  finalTool?: string;
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
  /** Last spoken assistant message for this turn, excluding tool traces/results. */
  finalMessage: string;
  tools: string[];
  toolEvents: ToolEvent[];
}

export interface ConversationResult {
  /** Aggregated, human-readable transcript (fed to the judge + transcript asserts). */
  transcript: string;
  /** Union of OKH tools called across all turns, sorted. */
  toolCalls: string[];
  /** Ordered tool events across all turns with untruncated arguments. */
  toolEvents: ToolEvent[];
  turns: ConversationTurn[];
  /** Last spoken assistant message, excluding tool traces/results. */
  finalMessage: string;
  /** Last turn's cumulative premiumRequests (== whole-conversation cost). */
  cost: number;
  /** Last turn's exit code. */
  code: number | null;
  timings: TurnTimings;
  /** If set, the conversation ended in a state-machine failure. */
  failure?: string;
  /** Explicit spawn/timeout/abort diagnostic from the last failed process. */
  processFailure?: string;
  processFailureKind?: ProcessFailureKind;
}

export interface RunConversationCtx {
  runner: CopilotTurnRunner;
  model?: string;
  copilotHome: string;
  cwd: string;
  timeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
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
  let sequenceOffset = 0;
  let cost = 0;
  let code: number | null = null;
  let state = "start";
  let failure: string | undefined;
  let processFailure: string | undefined;
  let processFailureKind: ProcessFailureKind | undefined;
  let finalMessage = "";
  const timings: TurnTimings = { totalMs: 0, agentMs: 0, toolMs: 0 };

  const runTurn = async (user: string, resume: boolean): Promise<CopilotTurnResult> => {
    if (ctx.abortSignal?.aborted) {
      throw new Error("Copilot conversation aborted");
    }
    const r = await ctx.runner({
      prompt: user,
      sessionId,
      resume,
      model: ctx.model,
      copilotHome: ctx.copilotHome,
      cwd: ctx.cwd,
      timeoutMs: ctx.timeoutMs,
      extraEnv: ctx.extraEnv,
      abortSignal: ctx.abortSignal,
      turn: turns.length + 1,
    });
    const toolEvents = r.toolEvents.map((event) => ({
      ...event,
      ...(event.startSequence === undefined
        ? {}
        : { startSequence: event.startSequence + sequenceOffset }),
      ...(event.completionSequence === undefined
        ? {}
        : { completionSequence: event.completionSequence + sequenceOffset }),
    }));
    const turnSequenceMax = r.toolEvents.reduce(
      (maximum, event) => Math.max(
        maximum,
        event.startSequence ?? 0,
        event.completionSequence ?? 0,
      ),
      0,
    );
    sequenceOffset += turnSequenceMax;
    turns.push({
      user,
      agent: r.render || r.messages.join("\n"),
      finalMessage: r.lastMessage,
      tools: r.tools,
      toolEvents,
    });
    if (r.timings) {
      timings.totalMs += r.timings.totalMs;
      timings.agentMs += r.timings.agentMs;
      timings.toolMs += r.timings.toolMs;
    }
    finalMessage = r.lastMessage;
    for (const ev of toolEvents) {
      allToolEvents.push(ev);
      if (ev.completed && ev.success && ev.server === OKH_SERVER) toolSet.add(ev.tool);
    }
    if (r.cost) cost = r.cost;
    code = r.code;
    processFailure ??= r.processFailure;
    processFailureKind ??= r.processFailureKind;
    return r;
  };

  const buildResult = (): ConversationResult => {
    const transcript = turns
      .map((t, i) => `=== USER (turn ${i + 1}) ===\n${t.user}\n\n=== AGENT (turn ${i + 1}) ===\n${t.agent}`)
      .join("\n\n");
    return {
      transcript,
      toolCalls: [...toolSet].sort(),
      turns,
      toolEvents: allToolEvents,
      finalMessage,
      cost,
      code,
      timings,
      ...(failure ? { failure } : {}),
      ...(processFailure ? { processFailure } : {}),
      ...(processFailureKind ? { processFailureKind } : {}),
    };
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
    if (script.terminal.finalTool) {
      const lastOkh = allToolEvents
        .filter((event) => event.server === OKH_SERVER && event.turn === turns.length)
        .at(-1);
      if (
        !lastOkh
        || lastOkh.tool !== script.terminal.finalTool
        || !lastOkh.completed
        || !lastOkh.success
      ) {
        failure = `terminal turn must end with successful ${script.terminal.finalTool}`;
        return true;
      }
    }
    return true; // terminal reached successfully
  };

  let last = await runTurn(script.initial, false);

  // Single-turn scripts still enforce an explicitly declared terminal contract.
  if (responses.length === 0) {
    if (script.terminal) {
      if (script.terminal.after !== "start") {
        failure = `single-turn conversation cannot reach terminal state "${script.terminal.after}"`;
      } else {
        checkTerminal();
      }
    }
    return buildResult();
  }

  while (turns.length < maxTurns) {
    if (last.processFailure || last.code !== 0) break;

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

  if (!failure && last.code === 0 && script.terminal) {
    if (state !== script.terminal.after) {
      failure = `max turns (${maxTurns}) exhausted without reaching terminal state "${script.terminal.after}"`;
    } else {
      checkTerminal();
    }
  }

  return buildResult();
}
