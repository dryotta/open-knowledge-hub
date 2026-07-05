import { describe, it, expect } from "vitest";
import {
  parseCopilotEvents,
  runConversation,
  type CopilotTurnRunner,
  type CopilotTurnResult,
} from "../eval/copilot.js";

const line = (o: unknown) => JSON.stringify(o);

describe("parseCopilotEvents", () => {
  it("extracts OKH tool names from toolRequests and tool.execution_start", () => {
    const jsonl = [
      line({
        type: "assistant.message",
        data: { content: "", toolRequests: [{ mcpServerName: "open-knowledge-hub", mcpToolName: "onboard" }] },
      }),
      line({ type: "tool.execution_start", data: { mcpServerName: "open-knowledge-hub", mcpToolName: "config" } }),
      line({ type: "tool.execution_start", data: { mcpServerName: "github-mcp-server", mcpToolName: "search_code" } }),
      line({ type: "assistant.message", data: { content: "All set." } }),
      line({ type: "result", sessionId: "abc", exitCode: 0, usage: { premiumRequests: 0.66 } }),
    ].join("\n");
    const p = parseCopilotEvents(jsonl);
    expect(p.tools).toEqual(["config", "onboard"]);
    expect(p.messages).toEqual(["All set."]);
    expect(p.lastMessage).toBe("All set.");
    expect(p.cost).toBe(0.66);
    expect(p.sessionId).toBe("abc");
    expect(p.code).toBe(0);
  });

  it("ignores non-OKH tool calls, blank messages, and non-JSON lines", () => {
    const jsonl = [
      "not json",
      line({ type: "assistant.reasoning_delta", data: { deltaContent: "thinking" } }),
      line({ type: "assistant.message", data: { content: "   " } }),
      line({ type: "tool.execution_start", data: { mcpServerName: "github-mcp-server", mcpToolName: "get_file_contents" } }),
    ].join("\n");
    const p = parseCopilotEvents(jsonl);
    expect(p.tools).toEqual([]);
    expect(p.messages).toEqual([]);
    expect(p.lastMessage).toBe("");
    expect(p.sessionId).toBeNull();
    expect(p.code).toBeNull();
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
    expect(p.messages).toEqual(["Let me set that up.", "Done — created my-notes."]);
    expect(p.render).toContain("Let me set that up.");
    expect(p.render).toContain("→ tool: open-knowledge-hub:add");
    expect(p.render).toContain("create");
    expect(p.render).toContain("← open-knowledge-hub:add");
    expect(p.render).toContain("Created container my-notes");
    expect(p.render).toContain("Done — created my-notes.");
  });
});

/** Fake turn-runner: scripts each turn's agent reply + tools by prompt substring. */
function fakeRunner(
  script: Array<{ match: string; agent: string; tools?: string[]; cost?: number; code?: number }>,
  seen: string[],
): CopilotTurnRunner {
  return async (opts): Promise<CopilotTurnResult> => {
    seen.push(opts.prompt);
    const hit = script.find((s) => opts.prompt.includes(s.match)) ?? { agent: "", tools: [], cost: 0, code: 0 };
    const messages = hit.agent ? [hit.agent] : [];
    return {
      messages,
      lastMessage: messages.at(-1) ?? "",
      tools: hit.tools ?? [],
      cost: hit.cost ?? 0,
      sessionId: opts.sessionId,
      code: hit.code ?? 0,
      raw: "",
      render: "",
    };
  };
}

const ctx = (runner: CopilotTurnRunner) => ({ runner, copilotHome: "/h", cwd: "/w" });

describe("runConversation", () => {
  it("sends turn 1, then picks guarded responses matching the agent's last message", async () => {
    const seen: string[] = [];
    const runner = fakeRunner(
      [
        { match: "start", agent: "Which wake phrase would you like?", tools: ["onboard"] },
        { match: "brain", agent: "Show me the plan? Ready to create?", tools: ["config"] },
        { match: "go ahead", agent: "Created. Here is how you use it day to day.", tools: ["add"] },
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
