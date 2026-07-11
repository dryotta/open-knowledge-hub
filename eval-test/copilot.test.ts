import { describe, it, expect } from "vitest";
import {
  parseCopilotEvents,
  runConversation,
  type CopilotTurnRunner,
  type CopilotTurnResult,
  type ToolEvent,
} from "../eval/copilot.js";

const line = (o: unknown) => JSON.stringify(o);

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
      ],
      seen,
    );
    const res = await runConversation(
      {
        initial: "start onboarding",
        responses: [
          { when: "wake phrase|name", send: "call it brain" },
          { when: "plan|create|ready", send: "yes go ahead" },
          { send: "thanks, everyday use?" },
        ],
      },
      ctx(runner),
    );
    expect(seen).toEqual(["start onboarding", "call it brain", "yes go ahead", "thanks, everyday use?"]);
    expect(res.toolCalls).toEqual(["add", "config", "onboard"]);
    expect(res.turns).toHaveLength(4);
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
      { initial: "initial prompt", responses: [{ send: "follow up" }] },
      ctx(runner),
    );
    expect(res.toolCalls).toEqual(["config", "run"]);
    expect(res.toolEvents).toHaveLength(2);
    expect(res.toolEvents[0]).toMatchObject({ tool: "run", turn: 1 });
    expect(res.toolEvents[1]).toMatchObject({ tool: "config", turn: 2 });
  });

  it("adapts when the agent reorders stages (guard match wins over declared order)", async () => {
    const seen: string[] = [];
    const runner = fakeRunner([{ match: "start", agent: "First, which container? existing or new folder?" }], seen);
    await runConversation(
      {
        initial: "start",
        responses: [
          { when: "wake phrase", send: "WAKE" },
          { when: "container|folder", send: "CONTAINER" },
        ],
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
      { initial: "start", responses: [{ when: "never-matches", send: "X" }] },
      ctx(runner),
    );
    expect(seen).toEqual(["start"]);
    expect(res.turns).toHaveLength(1);
  });

  it("caps the conversation at maxTurns", async () => {
    const seen: string[] = [];
    const runner = fakeRunner([], seen); // always empty agent reply
    const res = await runConversation(
      { initial: "start", responses: [{ send: "a" }, { send: "b" }, { send: "c" }], maxTurns: 2 },
      ctx(runner),
    );
    expect(res.turns).toHaveLength(2);
  });

  it("stops on a non-zero exit code", async () => {
    const seen: string[] = [];
    const runner = fakeRunner([{ match: "start", agent: "boom", code: 1 }], seen);
    const res = await runConversation({ initial: "start", responses: [{ send: "next" }] }, ctx(runner));
    expect(seen).toEqual(["start"]);
    expect(res.code).toBe(1);
  });
});
