import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import CopilotProvider, { normalizeTurns, parseTerminal } from "../eval/provider/copilotProvider.js";
import type { CopilotTurnRunner, CopilotTurnResult, ToolEvent } from "../eval/copilot.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const exists = async (p: string) => !!(await stat(p).catch(() => null));

const turn = (over: Partial<CopilotTurnResult> = {}): CopilotTurnResult => ({
  messages: [],
  lastMessage: "",
  tools: [],
  toolEvents: [],
  cost: 0,
  sessionId: "s",
  code: 0,
  raw: "",
  render: "",
  ...over,
});

const okhEvent = (callId: string, tool: string, t = 1): ToolEvent => ({
  turn: t,
  callId,
  server: "open-knowledge-hub",
  tool,
  arguments: {},
  completed: true,
  success: true,
});

describe("CopilotProvider", () => {
  it("provisions the env, runs a single (faked) turn, and returns transcript + metadata", async () => {
    const fake: CopilotTurnRunner = async (opts) => {
      expect(opts.copilotHome).toContain("copilot-home");
      expect(opts.prompt).toBe("answer: how does auth work?");
      expect(opts.resume).toBe(false);
      return turn({
        messages: ["auth uses tokens, done"],
        lastMessage: "auth uses tokens, done",
        tools: ["ask"],
        toolEvents: [okhEvent("c1", "ask", opts.turn)],
      });
    };
    const provider = new CopilotProvider({ config: { model: "test-model", runner: fake } });
    expect(provider.id()).toBeTruthy();

    const res = await provider.callApi("answer: how does auth work?", {
      vars: { env: "local-and-git" },
      test: { description: "ask-grounded" },
    });
    cleanups.push(res.metadata.workspace);

    expect(res.output).toContain("done");
    expect(res.metadata.toolCalls).toContain("ask");
    expect(res.metadata.toolEvents).toBeInstanceOf(Array);
    expect(res.metadata.toolEvents.length).toBeGreaterThan(0);
    expect(await exists(join(res.metadata.containerPath, "kb", ".okh", "module.yaml"))).toBe(true);
  });

  it("rejects when a conversation turn exits non-zero", async () => {
    const fake: CopilotTurnRunner = async () =>
      turn({ code: 1, messages: ["error"], lastMessage: "error" });
    const provider = new CopilotProvider({ config: { runner: fake } });
    await expect(
      provider.callApi("do something", { vars: { env: "empty" } }),
    ).rejects.toThrow(/Copilot turn.*exit code 1/);
  });

  it("drives guarded follow-up turns and aggregates tool calls across turns", async () => {
    const seen: string[] = [];
    const fake: CopilotTurnRunner = async (opts) => {
      seen.push(opts.prompt);
      if (opts.prompt.includes("set me up"))
        return turn({
          messages: ["Pick a wake phrase"],
          lastMessage: "Pick a wake phrase",
          tools: ["onboard"],
          toolEvents: [okhEvent("c1", "onboard", opts.turn)],
        });
      if (opts.prompt.includes("brain"))
        return turn({
          messages: ["Created it."],
          lastMessage: "Created it.",
          tools: ["config", "add"],
          toolEvents: [okhEvent("c2", "config", opts.turn), okhEvent("c3", "add", opts.turn)],
        });
      return turn({ messages: ["Done."], lastMessage: "Done." });
    };
    const provider = new CopilotProvider({ config: { runner: fake } });
    const res = await provider.callApi("Use the hub and set me up.", {
      vars: {
        env: "empty",
        turns: [
          { id: "wake", after: "start", when: "wake phrase", send: "call it brain" },
          { id: "thanks", after: "wake", send: "thanks" },
        ],
        terminal: { after: "thanks" },
      },
      test: { description: "onboard-multi-turn" },
    });
    cleanups.push(res.metadata.workspace);

    expect(seen[0]).toBe("Use the hub and set me up.");
    expect(seen[1]).toBe("call it brain");
    expect(res.metadata.toolCalls).toEqual(["add", "config", "onboard"]);
    expect(res.metadata.toolEvents).toBeInstanceOf(Array);
    expect(res.metadata.toolEvents.length).toBeGreaterThanOrEqual(3);
    expect(res.metadata.turns.length).toBeGreaterThanOrEqual(2);
  });

  it("empty env yields an empty registry + an unregistered notes folder", async () => {
    const provider = new CopilotProvider({
      config: { runner: async () => turn({ messages: ["ok"], lastMessage: "ok" }) },
    });
    const res = await provider.callApi("prompt", {
      vars: { env: "empty" },
      test: { description: "onboard-explains" },
    });
    cleanups.push(res.metadata.workspace);
    const reg = JSON.parse(await readFile(join(res.metadata.okhHome, "registry.json"), "utf8"));
    expect(reg.containers).toHaveLength(0);
  });

  it("throws when result.failure is set (state-machine failure propagation)", async () => {
    // Provide turns that will reach an unmatched state so runConversation returns failure
    const fake: CopilotTurnRunner = async (_opts) =>
      turn({ messages: ["tangent about weather"], lastMessage: "tangent about weather" });
    const provider = new CopilotProvider({ config: { runner: fake } });
    await expect(
      provider.callApi("start", {
        vars: {
          env: "empty",
          turns: [
            { id: "purpose", after: "start", when: "purpose", send: "purpose reply" },
          ],
          terminal: { after: "purpose" },
        },
      }),
    ).rejects.toThrow(/unmatched/i);
  });
});

describe("normalizeTurns", () => {
  it("requires non-empty id, after, send", () => {
    expect(() => normalizeTurns([{ id: "", after: "start", send: "hi" }])).toThrow();
    expect(() => normalizeTurns([{ id: "x", after: "", send: "hi" }])).toThrow();
    expect(() => normalizeTurns([{ id: "x", after: "start", send: "" }])).toThrow();
  });

  it("accepts after as string or non-empty string array", () => {
    const t1 = normalizeTurns([{ id: "a", after: "start", send: "hi" }]);
    expect(t1[0].after).toBe("start");
    const t2 = normalizeTurns([{ id: "a", after: ["start", "other"], send: "hi" }]);
    expect(t2[0].after).toEqual(["start", "other"]);
  });

  it("throws on empty after array", () => {
    expect(() => normalizeTurns([{ id: "a", after: [], send: "hi" }])).toThrow();
  });

  it("preserves optional when", () => {
    const t = normalizeTurns([{ id: "a", after: "start", send: "hi", when: "test" }]);
    expect(t[0].when).toBe("test");
  });

  it("throws on malformed entries (missing fields)", () => {
    expect(() => normalizeTurns([{ send: "hi" }])).toThrow();
    expect(() => normalizeTurns([{ id: "x", send: "hi" }])).toThrow();
    expect(() => normalizeTurns(["just a string"])).toThrow();
  });
});

describe("parseTerminal", () => {
  it("parses well-formed terminal", () => {
    const t = parseTerminal({ after: "done" });
    expect(t).toEqual({ after: "done" });
  });

  it("parses terminal with requiredTools", () => {
    const t = parseTerminal({ after: "done", requiredTools: ["run", "sync"] });
    expect(t).toEqual({ after: "done", requiredTools: ["run", "sync"] });
  });

  it("throws on missing after", () => {
    expect(() => parseTerminal({})).toThrow();
    expect(() => parseTerminal({ requiredTools: ["run"] })).toThrow();
  });

  it("throws on non-string after", () => {
    expect(() => parseTerminal({ after: 123 })).toThrow();
  });

  it("throws on non-array requiredTools", () => {
    expect(() => parseTerminal({ after: "x", requiredTools: "run" })).toThrow();
  });

  it("requires terminal when turns are non-empty", () => {
    const fake: CopilotTurnRunner = async () => turn({ messages: ["ok"], lastMessage: "ok" });
    const provider = new CopilotProvider({ config: { runner: fake } });
    return expect(
      provider.callApi("start", {
        vars: {
          env: "empty",
          turns: [{ id: "a", after: "start", send: "hi" }],
          // no terminal
        },
      }),
    ).rejects.toThrow(/terminal/i);
  });
});
