import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import CopilotProvider from "../eval/provider/copilotProvider.js";
import type { CopilotTurnRunner, CopilotTurnResult } from "../eval/copilot.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const exists = async (p: string) => !!(await stat(p).catch(() => null));

const turn = (over: Partial<CopilotTurnResult> = {}): CopilotTurnResult => ({
  messages: [],
  lastMessage: "",
  tools: [],
  cost: 0,
  sessionId: "s",
  code: 0,
  raw: "",
  render: "",
  ...over,
});

describe("CopilotProvider", () => {
  it("provisions the env, runs a single (faked) turn, and returns transcript + metadata", async () => {
    const fake: CopilotTurnRunner = async (opts) => {
      expect(opts.copilotHome).toContain("copilot-home");
      expect(opts.prompt).toBe("answer: how does auth work?");
      expect(opts.resume).toBe(false);
      return turn({ messages: ["auth uses tokens, done"], lastMessage: "auth uses tokens, done", tools: ["ask"] });
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
    expect(await exists(join(res.metadata.containerPath, "kb", ".okh", "module.yaml"))).toBe(true);
  });

  it("drives guarded follow-up turns and aggregates tool calls across turns", async () => {
    const seen: string[] = [];
    const fake: CopilotTurnRunner = async (opts) => {
      seen.push(opts.prompt);
      if (opts.prompt.includes("set me up"))
        return turn({ messages: ["Pick a wake phrase"], lastMessage: "Pick a wake phrase", tools: ["onboard"] });
      if (opts.prompt.includes("brain"))
        return turn({ messages: ["Created it."], lastMessage: "Created it.", tools: ["config", "add"] });
      return turn();
    };
    const provider = new CopilotProvider({ config: { runner: fake } });
    const res = await provider.callApi("Use the hub and set me up.", {
      vars: {
        env: "empty",
        turns: [{ when: "wake phrase", send: "call it brain" }, { send: "thanks" }],
      },
      test: { description: "onboard-multi-turn" },
    });
    cleanups.push(res.metadata.workspace);

    expect(seen[0]).toBe("Use the hub and set me up.");
    expect(seen[1]).toBe("call it brain");
    expect(res.metadata.toolCalls).toEqual(["add", "config", "onboard"]);
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
});
