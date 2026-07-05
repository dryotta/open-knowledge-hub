import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import CopilotProvider from "../eval/provider/copilotProvider.js";
import type { CopilotRunner } from "../eval/copilot.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const exists = async (p: string) => !!(await stat(p).catch(() => null));

describe("CopilotProvider", () => {
  it("provisions the env, runs the (faked) copilot, and returns transcript + metadata", async () => {
    const fake: CopilotRunner = async (opts) => {
      expect(opts.copilotHome).toContain("copilot-home");
      expect(opts.prompt).toBe("answer: how does auth work?");
      return { transcript: "Calling open-knowledge-hub__ask ... done", code: 0 };
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
    expect(await exists(join(res.metadata.containerPath, ".okh", "okh.yaml"))).toBe(true);
  });

  it("empty env yields an empty registry + an unregistered notes folder", async () => {
    const provider = new CopilotProvider({ config: { runner: async () => ({ transcript: "ok", code: 0 }) } });
    const res = await provider.callApi("prompt", {
      vars: { env: "empty" },
      test: { description: "onboard-explains" },
    });
    cleanups.push(res.metadata.workspace);
    const reg = JSON.parse(await readFile(join(res.metadata.okhHome, "registry.json"), "utf8"));
    expect(reg.containers).toHaveLength(0);
  });
});
