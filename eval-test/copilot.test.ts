import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCopilotTurnArgs,
  buildJudgeCopilotArgs,
  attachTermination,
  parseCopilotEvents,
  resolvedProcessExitCode,
  runConversation,
  spawnCopilotTurn,
  terminateProcessTree,
  terminateProcessTreeAndWait,
  type CopilotTurnRunner,
  type CopilotTurnResult,
  type ToolEvent,
  type ConversationScript,
} from "../eval/copilot.js";

const line = (o: unknown) => JSON.stringify(o);

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("buildJudgeCopilotArgs", () => {
  it("makes an infrastructure failure authoritative over a parsed success code", () => {
    expect(resolvedProcessExitCode(0, 0, "[judge timed out]")).toBeNull();
    expect(resolvedProcessExitCode(0, 1)).toBe(1);
    expect(resolvedProcessExitCode(0, null, "[judge exited from signal SIGKILL]")).toBeNull();
    expect(resolvedProcessExitCode(null, 1)).toBe(1);
  });

  it("uses a silent tool-free CLI invocation for judge-only calls", () => {
    expect(buildJudgeCopilotArgs("grade this", "gpt-5.6-luna")).toEqual([
      "-p",
      "grade this",
      "--allow-all",
      "--available-tools=",
      "--silent",
      "--no-color",
      "--no-custom-instructions",
      "--disable-builtin-mcps",
      "--no-remote-export",
      "--no-auto-update",
      "--model",
      "gpt-5.6-luna",
    ]);
  });

  describe("terminateProcessTree", () => {
    it("waits for a spawned process to exit after forced termination", async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      try {
        const closed = once(child, "close");
        await terminateProcessTree(child);
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            closed,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("child did not exit")), 5_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    });

    it("settles after forced termination even when close never arrives", async () => {
      const fakeExitedChild = {
        exitCode: 1,
        signalCode: null,
        stdin: null,
        stdout: null,
        stderr: null,
      } as ReturnType<typeof spawn>;
      const reason = await new Promise<string>((resolve) => {
        attachTermination(fakeExitedChild, 10, undefined, resolve);
      });
      expect(reason).toBe("timeout");
    });

    it("bounds waiting for open stdio when close never arrives", async () => {
      let stdoutDestroyed = false;
      const fakeChild = Object.assign(new EventEmitter(), {
        pid: undefined,
        exitCode: 1,
        signalCode: null,
        stdin: null,
        stdout: {
          destroyed: false,
          closed: false,
          destroy() {
            this.destroyed = true;
            stdoutDestroyed = true;
          },
        },
        stderr: null,
      }) as unknown as ReturnType<typeof spawn>;
      await terminateProcessTreeAndWait(fakeChild, 20);
      expect(stdoutDestroyed).toBe(true);
    });

    it("terminates descendants in the child's process group", async () => {
      const root = await mkdtemp(join(tmpdir(), "okh-process-tree-"));
      const heartbeat = join(root, "heartbeat");
      const grandchildScript = [
        'const { appendFileSync } = require("node:fs");',
        "const path = process.argv[1];",
        'setInterval(() => appendFileSync(path, "x"), 25);',
      ].join("");
      const parentScript = [
        'const { spawn } = require("node:child_process");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}, process.argv[1]], { stdio: "ignore" });`,
        "console.log(child.pid);",
        "setInterval(() => {}, 1000);",
      ].join("");
      const child = spawn(process.execPath, ["-e", parentScript, heartbeat], {
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      let grandchildPid: number | undefined;
      try {
        const [data] = await once(child.stdout!, "data");
        grandchildPid = Number(String(data).trim());
        expect(Number.isInteger(grandchildPid)).toBe(true);
        await waitFor(async () => (await readFile(heartbeat).catch(() => Buffer.alloc(0))).length > 0);

        const closed = once(child, "close");
        await terminateProcessTree(child);
        await closed;
        await waitFor(async () => !isProcessAlive(grandchildPid!));
        const firstSize = (await readFile(heartbeat)).length;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect((await readFile(heartbeat)).length).toBe(firstSize);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          await terminateProcessTree(child);
        }
        if (grandchildPid) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // Already terminated with the process tree.
          }
        }
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("buildCopilotTurnArgs", () => {
  it("uses deterministic flags and creates the requested session", () => {
    expect(buildCopilotTurnArgs({
      prompt: "do the task",
      sessionId: "session-1",
      resume: false,
      model: "claude-sonnet-4.5",
    })).toEqual([
      "-p",
      "do the task",
      "--allow-all",
      "--output-format",
      "json",
      "--no-color",
      "--no-custom-instructions",
      "--disable-builtin-mcps",
      "--no-remote-export",
      "--no-auto-update",
      "--session-id",
      "session-1",
      "--model",
      "claude-sonnet-4.5",
    ]);
  });

  it("resumes an existing session without requiring a model", () => {
    const args = buildCopilotTurnArgs({
      prompt: "continue",
      sessionId: "session-1",
      resume: true,
    });
    expect(args).toContain("--resume=session-1");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--model");
  });

  it("does not spawn a Copilot turn when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await spawnCopilotTurn({
      prompt: "never run",
      sessionId: "session-1",
      resume: false,
      copilotHome: "unused",
      cwd: "unused",
      abortSignal: controller.signal,
    });
    expect(result.code).toBeNull();
    expect(result.raw).toMatch(/aborted before Copilot turn started/i);
  });
});

describe("parseCopilotEvents", () => {
  it("does NOT count toolRequests or start-only; only completed+successful OKH events count", () => {
    const jsonl = [
      line({
        type: "assistant.message",
        data: { content: "", toolRequests: [{ mcpServerName: "open-knowledge-hub", mcpToolName: "onboard" }] },
      }),
      line({ type: "tool.execution_start", data: { toolCallId: "c1", mcpServerName: "open-knowledge-hub", mcpToolName: "config" } }),
      line({ type: "tool.execution_start", data: { toolCallId: "c2", mcpServerName: "github-mcp-server", mcpToolName: "search_code" } }),
      line({ type: "assistant.message", data: { content: "All set." } }),
      line({ type: "result", sessionId: "abc", exitCode: 0, usage: { premiumRequests: 0.66 } }),
    ].join("\n");
    const p = parseCopilotEvents(jsonl);
    // toolRequests and start-only events do NOT count toward tools
    expect(p.tools).toEqual([]);
    // two toolEvents tracked (one OKH start, one github start) — no completions
    expect(p.toolEvents).toHaveLength(2);
    expect(p.toolEvents[0]).toMatchObject({ callId: "c1", server: "open-knowledge-hub", tool: "config", completed: false, success: false, turn: 1 });
    expect(p.toolEvents[1]).toMatchObject({ callId: "c2", server: "github-mcp-server", tool: "search_code", completed: false, success: false });
    expect(p.messages).toEqual(["All set."]);
    expect(p.lastMessage).toBe("All set.");
    expect(p.cost).toBe(0.66);
    expect(p.sessionId).toBe("abc");
    expect(p.code).toBe(0);
  });

  it("tracks three OKH calls: successful run, failed sync, incomplete inspect", () => {
    const longInput = "x".repeat(350);
    const jsonl = [
      line({ type: "tool.execution_start", data: { toolCallId: "c1", mcpServerName: "open-knowledge-hub", mcpToolName: "run", arguments: { input: longInput } } }),
      line({ type: "tool.execution_complete", data: { toolCallId: "c1", success: true, result: { content: "done" } } }),
      line({ type: "tool.execution_start", data: { toolCallId: "c2", mcpServerName: "open-knowledge-hub", mcpToolName: "sync", arguments: {} } }),
      line({ type: "tool.execution_complete", data: { toolCallId: "c2", success: false, result: { content: "error" } } }),
      line({ type: "tool.execution_start", data: { toolCallId: "c3", mcpServerName: "open-knowledge-hub", mcpToolName: "inspect", arguments: {} } }),
      line({ type: "result", sessionId: "x", exitCode: 0 }),
    ].join("\n");
    const p = parseCopilotEvents(jsonl, 1);

    // Only the successful completed call counts
    expect(p.tools).toEqual(["run"]);
    expect(p.toolEvents).toHaveLength(3);

    const ev0 = p.toolEvents[0]!;
    expect(ev0.tool).toBe("run");
    expect(ev0.completed).toBe(true);
    expect(ev0.success).toBe(true);
    expect(ev0.turn).toBe(1);
    // Full arguments preserved in toolEvents (not truncated)
    expect((ev0.arguments as { input: string }).input).toBe(longInput);

    expect(p.toolEvents[1]).toMatchObject({ tool: "sync", completed: true, success: false });
    expect(p.toolEvents[2]).toMatchObject({ tool: "inspect", completed: false, success: false });

    // Render line for run has truncated args (200-char limit) — much shorter than 350-char input
    const runLine = p.render.split("\n").find((l) => l.includes("open-knowledge-hub:run"))!;
    expect(runLine).toBeDefined();
    expect(runLine.length).toBeLessThan(250);
  });

  it("ignores non-OKH tool calls, blank messages, and non-JSON lines", () => {
    const jsonl = [
      "not json",
      line({ type: "assistant.reasoning_delta", data: { deltaContent: "thinking" } }),
      line({ type: "assistant.message", data: { content: "   " } }),
      line({ type: "tool.execution_start", data: { toolCallId: "c1", mcpServerName: "github-mcp-server", mcpToolName: "get_file_contents" } }),
    ].join("\n");
    const p = parseCopilotEvents(jsonl);
    expect(p.tools).toEqual([]);
    expect(p.messages).toEqual([]);
    expect(p.lastMessage).toBe("");
    expect(p.sessionId).toBeNull();
    expect(p.code).toBeNull();
    // Non-OKH tool tracked in toolEvents but not in tools
    expect(p.toolEvents).toHaveLength(1);
    expect(p.toolEvents[0]).toMatchObject({ server: "github-mcp-server", tool: "get_file_contents", completed: false });
  });

  it("renders messages interleaved with tool calls and results (so the judge sees actions)", () => {
    const jsonl = [
      line({ type: "assistant.message", data: { content: "Let me set that up." } }),
      line({
        type: "tool.execution_start",
        data: {
          toolCallId: "c1",
          mcpServerName: "open-knowledge-hub",
          mcpToolName: "add",
          arguments: { source: "my-notes", create: true },
        },
      }),
      line({
        type: "tool.execution_complete",
        data: { toolCallId: "c1", success: true, result: { content: "Created container my-notes with module kb." } },
      }),
      line({ type: "assistant.message", data: { content: "Done — created my-notes." } }),
    ].join("\n");
    const p = parseCopilotEvents(jsonl);
    expect(p.tools).toEqual(["add"]);
    expect(p.toolEvents).toHaveLength(1);
    expect(p.toolEvents[0]).toMatchObject({ tool: "add", completed: true, success: true });
    expect(p.messages).toEqual(["Let me set that up.", "Done — created my-notes."]);
    expect(p.render).toContain("Let me set that up.");
    expect(p.render).toContain("→ tool: open-knowledge-hub:add");
    expect(p.render).toContain("create");
    expect(p.render).toContain("← open-knowledge-hub:add");
    expect(p.render).toContain("Created container my-notes");
    expect(p.render).toContain("Done — created my-notes.");
    expect((p as { toolEvents?: unknown }).toolEvents).toEqual([
     { turn: 1, callId: "c1", server: "open-knowledge-hub", tool: "add", arguments: { source: "my-notes", create: true }, completed: true, success: true },
    ]);
  });
});

/** Fake turn-runner: scripts each turn's agent reply + toolEvents by prompt substring. */
function fakeRunner(
  script: Array<{ match: string; agent: string; toolEvents?: ToolEvent[]; cost?: number; code?: number }>,
  seen: string[],
): CopilotTurnRunner {
  return async (opts): Promise<CopilotTurnResult> => {
    seen.push(opts.prompt);
    const hit = script.find((s) => opts.prompt.includes(s.match)) ?? { agent: "", toolEvents: [] as ToolEvent[], cost: 0, code: 0 };
    const messages = hit.agent ? [hit.agent] : [];
    const toolEvents = (hit.toolEvents ?? []).map((e) => ({ ...e, turn: opts.turn ?? e.turn }));
    const tools = [
      ...new Set(
        toolEvents
          .filter((e) => e.completed && e.success && e.server === "open-knowledge-hub")
          .map((e) => e.tool),
      ),
    ].sort();
    return {
      messages,
      lastMessage: messages.at(-1) ?? "",
      tools,
      toolEvents,
      cost: hit.cost ?? 0,
      sessionId: opts.sessionId,
      code: hit.code ?? 0,
      raw: "",
      render: "",
    };
  };
}

const ctx = (runner: CopilotTurnRunner) => ({ runner, copilotHome: "/h", cwd: "/w" });

const okh = (callId: string, tool: string): ToolEvent => ({
  turn: 0,
  callId,
  server: "open-knowledge-hub",
  tool,
  arguments: {},
  completed: true,
  success: true,
});

describe("runConversation", () => {
  it("sends turn 1, then picks guarded responses matching the agent's last message", async () => {
    const seen: string[] = [];
    const runner = fakeRunner(
      [
        { match: "start", agent: "Which wake phrase would you like?", toolEvents: [okh("c1", "onboard")] },
        { match: "brain", agent: "Show me the plan? Ready to create?", toolEvents: [okh("c2", "config")] },
        { match: "go ahead", agent: "Created. Here is how you use it day to day.", toolEvents: [okh("c3", "add")] },
        { match: "everyday", agent: "Done!" },
      ],
      seen,
    );
    const res = await runConversation(
      {
        initial: "start onboarding",
        responses: [
          { id: "wake", after: "start", when: "wake phrase|name", send: "call it brain" },
          { id: "plan", after: "wake", when: "plan|create|ready", send: "yes go ahead" },
          { id: "everyday", after: "plan", send: "thanks, everyday use?" },
        ],
        terminal: { after: "everyday" },
      },
      ctx(runner),
    );
    expect(seen).toEqual(["start onboarding", "call it brain", "yes go ahead", "thanks, everyday use?"]);
    expect(res.toolCalls).toEqual(["add", "config", "onboard"]);
    expect(res.turns).toHaveLength(4);
    expect(res.finalMessage).toBe("Done!");
    expect(res.transcript).toContain("=== USER (turn 1) ===");
    expect(res.transcript).toContain("Which wake phrase");
  });

  it("aggregates toolEvents across turns with correct turn numbers", async () => {
    const seen: string[] = [];
    const runner: CopilotTurnRunner = async (opts): Promise<CopilotTurnResult> => {
      seen.push(opts.prompt);
      if (opts.prompt.includes("initial")) {
        return {
          messages: ["Turn 1 response"],
          lastMessage: "Turn 1 response",
          tools: ["run"],
          toolEvents: [{ turn: opts.turn!, callId: "c1", server: "open-knowledge-hub", tool: "run", arguments: {}, completed: true, success: true }],
          cost: 0,
          sessionId: opts.sessionId,
          code: 0,
          raw: "",
          render: "",
        };
      }
      return {
        messages: ["Turn 2 response"],
        lastMessage: "Turn 2 response",
        tools: ["config"],
        toolEvents: [{ turn: opts.turn!, callId: "c2", server: "open-knowledge-hub", tool: "config", arguments: {}, completed: true, success: true }],
        cost: 0,
        sessionId: opts.sessionId,
        code: 0,
        raw: "",
        render: "",
      };
    };
    const res = await runConversation(
      { initial: "initial prompt", responses: [{ id: "follow", after: "start", send: "follow up" }], terminal: { after: "follow" } },
      ctx(runner),
    );
    expect(res.toolCalls).toEqual(["config", "run"]);
    expect(res.toolEvents).toHaveLength(2);
    expect(res.toolEvents[0]).toMatchObject({ tool: "run", turn: 1 });
    expect(res.toolEvents[1]).toMatchObject({ tool: "config", turn: 2 });
  });

  it("preserves structured tool event order across resumed turns", async () => {
    const runner = fakeRunner([
      {
        match: "start",
        agent: "Please confirm.",
        toolEvents: [
          {
            turn: 0,
            callId: "t1",
            server: "open-knowledge-hub",
            tool: "todos",
            arguments: { operation: "update", ref: "r1", completed: true },
            completed: true,
            success: true,
          },
        ],
      },
      {
        match: "confirm",
        agent: "Done.",
        toolEvents: [
          {
            turn: 0,
            callId: "t2",
            server: "open-knowledge-hub",
            tool: "todos",
            arguments: { operation: "update", ref: "r1", completed: true, apply: true },
            completed: true,
            success: true,
          },
          { turn: 0, callId: "t3", server: "open-knowledge-hub", tool: "sync", arguments: { container: "kb-hub" }, completed: true, success: true },
        ],
      },
    ], []);
    const res = await runConversation(
      { initial: "start", responses: [{ id: "confirm", after: "start", when: "confirm", send: "confirm" }], terminal: { after: "confirm" } },
      ctx(runner),
    );
    expect(res.toolEvents).toHaveLength(3);
    expect(res.toolEvents[0]).toMatchObject({ tool: "todos", turn: 1, arguments: { operation: "update", ref: "r1", completed: true } });
    expect(res.toolEvents[1]).toMatchObject({ tool: "todos", turn: 2, arguments: { operation: "update", ref: "r1", completed: true, apply: true } });
    expect(res.toolEvents[2]).toMatchObject({ tool: "sync", turn: 2, arguments: { container: "kb-hub" } });
  });

  it("adapts when the agent reorders stages (guard match wins over declared order)", async () => {
    const seen: string[] = [];
    const runner = fakeRunner([{ match: "start", agent: "First, which container? existing or new folder?" }], seen);
    await runConversation(
      {
        initial: "start",
        responses: [
          { id: "wake", after: "start", when: "wake phrase", send: "WAKE" },
          { id: "container", after: "start", when: "container|folder", send: "CONTAINER" },
        ],
        terminal: { after: "container" },
      },
      ctx(runner),
    );
    // Agent asked about container first → the container-guarded reply fires before the wake reply.
    expect(seen[1]).toBe("CONTAINER");
  });

  it("stops when no response is eligible (all guarded, none match)", async () => {
    const seen: string[] = [];
    const runner = fakeRunner([{ match: "start", agent: "unrelated question" }], seen);
    const res = await runConversation(
      { initial: "start", responses: [{ id: "x", after: "start", when: "never-matches", send: "X" }], terminal: { after: "x" } },
      ctx(runner),
    );
    expect(seen).toEqual(["start"]);
    expect(res.turns).toHaveLength(1);
    expect(res.failure).toBeDefined();
  });

  it("caps the conversation at maxTurns", async () => {
    const seen: string[] = [];
    const runner = fakeRunner([], seen); // always empty agent reply
    const res = await runConversation(
      { initial: "start", responses: [{ id: "a", after: "start", send: "a" }, { id: "b", after: "a", send: "b" }, { id: "c", after: "b", send: "c" }], terminal: { after: "c" }, maxTurns: 2 },
      ctx(runner),
    );
    expect(res.turns).toHaveLength(2);
  });

  it("stops on a non-zero exit code", async () => {
    const seen: string[] = [];
    const runner = fakeRunner([{ match: "start", agent: "boom", code: 1 }], seen);
    const res = await runConversation({ initial: "start", responses: [{ send: "next", id: "n", after: "start" }], terminal: { after: "n" } }, ctx(runner));
    expect(seen).toEqual(["start"]);
    expect(res.code).toBe(1);
  });

  it("stops immediately and preserves a process failure even if a runner reports code zero", async () => {
    const seen: string[] = [];
    const runner: CopilotTurnRunner = async (opts) => {
      seen.push(opts.prompt);
      return {
        messages: [],
        lastMessage: "",
        tools: [],
        toolEvents: [],
        cost: 0,
        sessionId: opts.sessionId,
        code: 0,
        raw: "",
        render: "",
        processFailure: "[Copilot turn timed out after 10ms]",
        processFailureKind: "timeout",
      };
    };
    const res = await runConversation(
      {
        initial: "start",
        responses: [{ send: "next", id: "n", after: "start" }],
        terminal: { after: "n" },
      },
      ctx(runner),
    );
    expect(seen).toEqual(["start"]);
    expect(res.processFailureKind).toBe("timeout");
    expect(res.processFailure).toMatch(/timed out/);
  });
});

describe("runConversation — state machine", () => {
  it("a container reply cannot fire from start (only after matching predecessor)", async () => {
    const seen: string[] = [];
    // Agent turn 1 says something about containers
    const runner = fakeRunner(
      [{ match: "start", agent: "Which container do you want?" }],
      seen,
    );
    const script: ConversationScript = {
      initial: "start onboarding",
      responses: [
        { id: "purpose", after: "start", when: "purpose|goal", send: "purpose reply" },
        { id: "container", after: "purpose", when: "container", send: "create my-notes" },
      ],
      terminal: { after: "container" },
    };
    const res = await runConversation(script, ctx(runner));
    // "container" turn has after:"purpose", so it can't fire from state "start"
    // even though the agent message matches "container"
    expect(seen).toEqual(["start onboarding"]);
    expect(res.failure).toContain("start");
    expect(res.failure).toContain("container");
  });

  it("alternatives after:[purpose,goals] work — eligible from multiple predecessors", async () => {
    const seen: string[] = [];
    const runner = fakeRunner(
      [
        { match: "initial", agent: "What is the purpose?" },
        { match: "purpose reply", agent: "Now the scope?" },
      ],
      seen,
    );
    const script: ConversationScript = {
      initial: "initial prompt",
      responses: [
        { id: "purpose", after: "start", when: "purpose", send: "purpose reply" },
        { id: "goals", after: "start", when: "goals", send: "goals reply" },
        { id: "scope", after: ["purpose", "goals"], when: "scope", send: "scope reply" },
      ],
      terminal: { after: "scope" },
    };
    const res = await runConversation(script, ctx(runner));
    // purpose fires from start → state becomes "purpose"
    // scope has after:["purpose","goals"], so it's eligible from "purpose"
    expect(seen).toEqual(["initial prompt", "purpose reply", "scope reply"]);
    expect(res.failure).toBeUndefined();
  });

  it("unmatched eligible guards return failure containing state and last agent message", async () => {
    const seen: string[] = [];
    const runner = fakeRunner(
      [
        { match: "start", agent: "What is the purpose?" },
        { match: "purpose", agent: "Completely unrelated tangent about weather" },
      ],
      seen,
    );
    const script: ConversationScript = {
      initial: "start",
      responses: [
        { id: "purpose", after: "start", when: "purpose", send: "purpose reply" },
        { id: "scope", after: "purpose", when: "scope|boundary", send: "scope reply" },
      ],
      terminal: { after: "scope" },
    };
    const res = await runConversation(script, ctx(runner));
    expect(res.failure).toBeDefined();
    expect(res.failure).toContain("purpose"); // current state
    expect(res.failure).toContain("weather"); // last agent message snippet
  });

  it("terminal state fails when a required successful tool is absent", async () => {
    const seen: string[] = [];
    const runner = fakeRunner(
      [
        { match: "start", agent: "What is the purpose?", toolEvents: [okh("c1", "run")] },
        { match: "purpose", agent: "Done!", toolEvents: [okh("c2", "config")] },
      ],
      seen,
    );
    const script: ConversationScript = {
      initial: "start",
      responses: [
        { id: "purpose", after: "start", when: "purpose", send: "purpose reply" },
      ],
      terminal: { after: "purpose", requiredTools: ["run", "sync"] },
    };
    const res = await runConversation(script, ctx(runner));
    // terminal.after === state "purpose", but "sync" was never successfully called
    expect(res.failure).toBeDefined();
    expect(res.failure).toContain("sync");
  });

  it("no unguarded terminal reply fires early just because it lacks when", async () => {
    const seen: string[] = [];
    // If a turn has no `when`, it should NOT fire unless its `after` matches state
    const runner = fakeRunner(
      [
        { match: "start", agent: "Let me ask about purpose" },
        { match: "purpose reply", agent: "Great, wrapping up" },
      ],
      seen,
    );
    const script: ConversationScript = {
      initial: "start",
      responses: [
        { id: "purpose", after: "start", when: "purpose", send: "purpose reply" },
        // wrap-up has no `when` but its `after` is "purpose" — it should NOT fire from "start"
        { id: "wrapup", after: "purpose", send: "wrap-up message" },
      ],
      terminal: { after: "wrapup" },
    };
    const res = await runConversation(script, ctx(runner));
    // From state "start", only "purpose" (after:"start") is eligible — wrapup is not
    // From state "purpose", wrapup (after:"purpose", no when) fires
    expect(seen).toEqual(["start", "purpose reply", "wrap-up message"]);
    expect(res.failure).toBeUndefined();
  });

  it("single-turn scripts with no responses remain valid and complete after turn 1", async () => {
    const seen: string[] = [];
    const runner = fakeRunner([{ match: "hello", agent: "world" }], seen);
    const res = await runConversation({ initial: "hello", responses: [] }, ctx(runner));
    expect(res.turns).toHaveLength(1);
    expect(res.failure).toBeUndefined();
    expect(res.finalMessage).toBe("world");
  });

  it("single-turn scripts enforce terminal requiredTools", async () => {
    const seen: string[] = [];
    const runner = fakeRunner([
      { match: "hello", agent: "done", toolEvents: [okh("c1", "run")] },
    ], seen);
    const success = await runConversation({
      initial: "hello",
      responses: [],
      terminal: { after: "start", requiredTools: ["run"] },
    }, ctx(runner));
    expect(success.failure).toBeUndefined();

    const missing = await runConversation({
      initial: "hello",
      responses: [],
      terminal: { after: "start", requiredTools: ["sync"] },
    }, ctx(runner));
    expect(missing.failure).toMatch(/sync/);
  });

  it("terminal finalTool must be the last successful OKH call on the terminal turn", async () => {
    const successRunner = fakeRunner([{
      match: "hello",
      agent: "done",
      toolEvents: [okh("c1", "run"), okh("c2", "sync")],
    }], []);
    const success = await runConversation({
      initial: "hello",
      responses: [],
      terminal: { after: "start", finalTool: "sync" },
    }, ctx(successRunner));
    expect(success.failure).toBeUndefined();

    const failureRunner = fakeRunner([{
      match: "hello",
      agent: "done",
      toolEvents: [okh("c1", "sync"), okh("c2", "inspect")],
    }], []);
    const failure = await runConversation({
      initial: "hello",
      responses: [],
      terminal: { after: "start", finalTool: "sync" },
    }, ctx(failureRunner));
    expect(failure.failure).toMatch(/must end with successful sync/i);
  });

  it("enforces terminal finalTool when terminal state is reached at maxTurns", async () => {
    const runner = fakeRunner([
      { match: "hello", agent: "continue" },
      {
        match: "finish",
        agent: "done",
        toolEvents: [okh("c1", "sync"), okh("c2", "inspect")],
      },
    ], []);
    const result = await runConversation({
      initial: "hello",
      responses: [{ id: "done", after: "start", send: "finish" }],
      terminal: { after: "done", finalTool: "sync" },
      maxTurns: 2,
    }, ctx(runner));
    expect(result.failure).toMatch(/must end with successful sync/i);
  });

  it("single-turn scripts fail when the declared terminal state is unreachable", async () => {
    const seen: string[] = [];
    const runner = fakeRunner([{ match: "hello", agent: "done" }], seen);
    const res = await runConversation({
      initial: "hello",
      responses: [],
      terminal: { after: "later" },
    }, ctx(runner));
    expect(res.failure).toMatch(/cannot reach terminal state "later"/);
  });

  it("fully unguarded linear chain fires each turn strictly by after-state despite arbitrary agent wording", async () => {
    const seen: string[] = [];
    // Agent says completely unrelated things at each step — no regex could match.
    const runner = fakeRunner(
      [
        { match: "start", agent: "I like turtles" },
        { match: "step-a", agent: "The weather is nice" },
        { match: "step-b", agent: "42 is the answer" },
        { match: "step-c", agent: "Farewell" },
      ],
      seen,
    );
    const script: ConversationScript = {
      initial: "start the chain",
      responses: [
        { id: "a", after: "start", send: "step-a reply" },
        { id: "b", after: "a", send: "step-b reply" },
        { id: "c", after: "b", send: "step-c reply" },
        { id: "d", after: "c", send: "step-d reply" },
      ],
      terminal: { after: "d" },
    };
    const res = await runConversation(script, ctx(runner));
    // Every turn fires in declared order despite no guards and nonsense agent text
    expect(seen).toEqual(["start the chain", "step-a reply", "step-b reply", "step-c reply", "step-d reply"]);
    expect(res.failure).toBeUndefined();
    expect(res.turns).toHaveLength(5);
  });

  it("unguarded turn cannot fire before its predecessor completes", async () => {
    const seen: string[] = [];
    // Only one agent response to keep things short
    const runner = fakeRunner(
      [{ match: "start", agent: "anything" }],
      seen,
    );
    const script: ConversationScript = {
      initial: "start",
      responses: [
        // b depends on a, but a depends on start — so b can't fire from start
        { id: "a", after: "start", send: "a-reply" },
        { id: "b", after: "a", send: "b-reply" },
      ],
      terminal: { after: "b" },
      maxTurns: 3,
    };
    const res = await runConversation(script, ctx(runner));
    // a fires first (after:start), then b (after:a) — order is correct
    expect(seen).toEqual(["start", "a-reply", "b-reply"]);
    expect(res.failure).toBeUndefined();
  });

  it("max-turn limit reports nonterminal exhaustion as failure", async () => {
    const seen: string[] = [];
    // Agent always says "purpose" so the loop goes on, but maxTurns limits it
    const runner = fakeRunner([
      { match: "start", agent: "What is the purpose?" },
      { match: "purpose", agent: "What is the purpose again?" },
    ], seen);
    const script: ConversationScript = {
      initial: "start",
      responses: [
        { id: "purpose", after: "start", when: "purpose", send: "purpose reply" },
        { id: "scope", after: "purpose", when: "scope", send: "scope reply" },
      ],
      terminal: { after: "scope" },
      maxTurns: 2,
    };
    const res = await runConversation(script, ctx(runner));
    expect(res.turns).toHaveLength(2);
    expect(res.failure).toBeDefined();
    expect(res.failure).toContain("max");
  });
});
