import { describe, it, expect } from "vitest";
import {
  DEFAULT_MANUAL_ENV,
  buildCopilotInvocation,
  loadScenarios,
  parseManualArgs,
  scenariosForEnv,
} from "../eval/manual.js";

describe("manual testing helpers", () => {
  it("defaults to local-and-git", () => {
    expect(parseManualArgs([])).toEqual({ env: DEFAULT_MANUAL_ENV, model: undefined });
  });

  it("accepts explicit wiki env and model", () => {
    expect(parseManualArgs(["wiki", "--model", "claude-sonnet-4.5"])).toEqual({
      env: "wiki",
      model: "claude-sonnet-4.5",
    });
  });

  it.each([
    [["unknown"], /unknown environment/i],
    [["--model"], /requires a value/i],
    [["wiki", "git"], /unexpected argument/i],
    [["--wat"], /unknown option/i],
  ])("rejects invalid arguments: %j", (argv, message) => {
    expect(() => parseManualArgs(argv as string[])).toThrow(message);
  });

  it("loads all scenario prompts and groups them by environment", async () => {
    const all = await loadScenarios();
    expect(all).toHaveLength(28);
    expect(await scenariosForEnv("local-and-git")).toHaveLength(12);
    expect(await scenariosForEnv("git")).toHaveLength(1);
    expect(await scenariosForEnv("empty")).toHaveLength(8);
    expect(await scenariosForEnv("custom")).toHaveLength(2);
    expect(await scenariosForEnv("wiki")).toHaveLength(3);
    expect(await scenariosForEnv("health")).toHaveLength(2);
    for (const scenario of all) {
      expect(scenario.prompt).not.toHaveLength(0);
      expect(scenario.checklist).not.toHaveLength(0);
    }
  });

  it("builds an isolated Copilot invocation", () => {
    expect(
      buildCopilotInvocation(
        { workspace: "C:\\temp\\workspace", copilotHome: "C:\\temp\\copilot-home" },
        "test-model",
      ),
    ).toEqual({
      command: "copilot",
      args: ["--allow-all", "--model", "test-model"],
      cwd: "C:\\temp\\workspace",
      env: { COPILOT_HOME: "C:\\temp\\copilot-home" },
    });
  });
});
