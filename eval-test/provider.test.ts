import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import CopilotProvider, { normalizeTurns, parseTerminal } from "../eval/provider/copilotProvider.js";
import type { CopilotTurnRunner, CopilotTurnResult, ToolEvent } from "../eval/copilot.js";
import { makeTempDir } from "../test/helpers.js";

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
    cleanups.push(res.metadata.root);

    expect(res.output).toContain("done");
    expect(res.metadata.workspace).toBe(join(res.metadata.root, "workspace"));
    expect(res.metadata.finalMessage).toBe("auth uses tokens, done");
    expect(res.metadata.toolCalls).toContain("ask");
    expect(res.metadata.toolEvents).toBeInstanceOf(Array);
    expect(res.metadata.toolEvents.length).toBeGreaterThan(0);
    expect(await exists(join(res.metadata.containerPath, "kb", ".okh", "module.yaml"))).toBe(true);
  });

  it("returns an error with metadata when a conversation turn exits non-zero", async () => {
    const fake: CopilotTurnRunner = async () =>
      turn({ code: 1, messages: ["error"], lastMessage: "error" });
    const provider = new CopilotProvider({ config: { runner: fake } });
    const res = await provider.callApi("do something", { vars: { env: "empty" } });
    cleanups.push(res.metadata.root);
    expect(res.error).toMatch(/Copilot turn.*exit code 1/);
    expect(res.output).toContain("error");
    expect(res.metadata.exitCode).toBe(1);
  });

  it("preserves an explicit timeout diagnostic", async () => {
    const fake: CopilotTurnRunner = async () =>
      turn({
        code: null,
        processFailure: "[Copilot turn timed out after 300000ms]",
        processFailureKind: "timeout",
      });
    const provider = new CopilotProvider({ config: { runner: fake } });
    const res = await provider.callApi("do something", { vars: { env: "empty" } });
    cleanups.push(res.metadata.root);
    expect(res.error).toContain("timed out after 300000ms");
    expect(res.metadata.processFailure).toBe("[Copilot turn timed out after 300000ms]");
  });

  it("retries a typed infrastructure failure in a fresh environment", async () => {
    const roots: string[] = [];
    let calls = 0;
    const provider = new CopilotProvider({
      config: {
        maxAttempts: 2,
        provisioner: async () => {
          const root = await makeTempDir("provider-retry-");
          roots.push(root);
          return {
            root,
            okhHome: join(root, "okh-home"),
            copilotHome: join(root, "copilot-home"),
            workspace: join(root, "workspace"),
            containerPath: join(root, "container"),
            fixtureDir: join(root, "fixture"),
          };
        },
        runner: async () => {
          calls++;
          if (calls === 1) {
            return turn({
              code: null,
              cost: 2,
              processFailure: "[spawn error] unavailable",
              processFailureKind: "spawn",
            });
          }
          return turn({ messages: ["done"], lastMessage: "done", cost: 3 });
        },
      },
    });

    const res = await provider.callApi("start", { vars: { env: "empty" } });
    cleanups.push(res.metadata.root);
    expect(calls).toBe(2);
    expect(res.error).toBeUndefined();
    expect(res.output).toContain("done");
    expect(res.metadata).toMatchObject({
      root: roots[1],
      attempts: 2,
      cost: 5,
      costIncomplete: true,
      retryErrors: ["Copilot turn failed: [spawn error] unavailable"],
    });
    expect(await exists(roots[0]!)).toBe(false);
    expect(await exists(roots[1]!)).toBe(true);
  });

  it("does not retry an ordinary non-zero exit", async () => {
    let calls = 0;
    const provider = new CopilotProvider({
      config: {
        maxAttempts: 2,
        runner: async () => {
          calls++;
          return turn({ code: 1 });
        },
      },
    });
    const res = await provider.callApi("start", { vars: { env: "empty" } });
    cleanups.push(res.metadata.root);
    expect(calls).toBe(1);
    expect(res.error).toMatch(/exit code 1/);
    expect(res.metadata.attempts).toBe(1);
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
    cleanups.push(res.metadata.root);

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
    cleanups.push(res.metadata.root);
    const reg = JSON.parse(await readFile(join(res.metadata.okhHome, "registry.json"), "utf8"));
    expect(reg.containers).toHaveLength(0);
  });

  it("forwards promptfoo cancellation to the Copilot runner", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const provider = new CopilotProvider({
      config: {
        runner: async (opts) => {
          seenSignal = opts.abortSignal;
          return turn({ messages: ["ok"], lastMessage: "ok" });
        },
      },
    });
    const res = await provider.callApi(
      "prompt",
      { vars: { env: "empty" } },
      { abortSignal: controller.signal },
    );
    cleanups.push(res.metadata.root);
    expect(seenSignal).toBe(controller.signal);
  });

  it("returns state-machine failures with diagnostic metadata", async () => {
    // Provide turns that will reach an unmatched state so runConversation returns failure
    const fake: CopilotTurnRunner = async (_opts) =>
      turn({ messages: ["tangent about weather"], lastMessage: "tangent about weather" });
    const provider = new CopilotProvider({ config: { runner: fake } });
    const res = await provider.callApi("start", {
      vars: {
        env: "empty",
        turns: [
          { id: "purpose", after: "start", when: "purpose", send: "purpose reply" },
        ],
        terminal: { after: "purpose" },
      },
    });
    cleanups.push(res.metadata.root);
    expect(res.error).toMatch(/unmatched/i);
    expect(res.metadata.turns).toHaveLength(1);
    expect(res.metadata.finalMessage).toMatch(/weather/i);
  });

  it("removes the provisioned environment when the runner throws", async () => {
    const root = await makeTempDir("provider-cleanup-");
    cleanups.push(root);
    const provider = new CopilotProvider({
      config: {
        provisioner: async () => ({
          root,
          okhHome: join(root, "okh-home"),
          copilotHome: join(root, "copilot-home"),
          workspace: join(root, "workspace"),
          containerPath: join(root, "container"),
          fixtureDir: join(root, "fixture"),
        }),
        runner: async () => {
          throw new Error("runner exploded");
        },
      },
    });

    await expect(provider.callApi("start", { vars: { env: "empty" } })).rejects.toThrow(/runner exploded/);
    expect(await exists(root)).toBe(false);
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
    const t = parseTerminal({ after: "done", requiredTools: ["run", "sync"], finalTool: "sync" });
    expect(t).toEqual({ after: "done", requiredTools: ["run", "sync"], finalTool: "sync" });
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

  it("throws on invalid finalTool", () => {
    expect(() => parseTerminal({ after: "x", finalTool: "" })).toThrow();
    expect(() => parseTerminal({ after: "x", finalTool: 123 })).toThrow();
  });

  it("requires terminal before provisioning when turns are non-empty", async () => {
    const fake: CopilotTurnRunner = async () => turn({ messages: ["ok"], lastMessage: "ok" });
    let provisioned = false;
    const provider = new CopilotProvider({
      config: {
        runner: fake,
        provisioner: async () => {
          provisioned = true;
          throw new Error("must not provision");
        },
      },
    });
    await expect(provider.callApi("start", {
        vars: {
          env: "empty",
          turns: [{ id: "a", after: "start", send: "hi" }],
          // no terminal
        },
      }))
      .rejects.toThrow(/terminal/i);
    expect(provisioned).toBe(false);
  });
});
