import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import CopilotProvider from "../eval/provider/copilotProvider.js";
import { makeTempDir } from "../test/helpers.js";
import type { CopilotRunner } from "../eval/copilot.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeFixture(): Promise<string> {
  const dir = await makeTempDir("okh-fix-"); cleanups.push(dir);
  await mkdir(join(dir, ".okh"), { recursive: true });
  await writeFile(join(dir, ".okh", "okh.yaml"), "name: hub\nsync: auto\nmodules:\n  - path: kb\n    type: knowledge\n", "utf8");
  await mkdir(join(dir, "kb"), { recursive: true });
  await writeFile(join(dir, "kb", "index.md"), "# Knowledge\n", "utf8");
  return dir;
}

describe("CopilotProvider", () => {
  it("provisions, runs the (faked) copilot, and returns transcript + metadata", async () => {
    const fixtureDir = await makeFixture();
    const fake: CopilotRunner = async (opts) => {
      // prove the provider wired the isolated home + prompt through
      expect(opts.copilotHome).toContain("copilot-home");
      expect(opts.prompt).toBe("answer: how does auth work?");
      return { transcript: "Calling open-knowledge-hub__ask ... done", code: 0 };
    };
    const provider = new CopilotProvider({ config: { model: "test-model", runner: fake } });
    expect(provider.id()).toBeTruthy();

    const res = await provider.callApi("answer: how does auth work?", {
      vars: { scenario: "ask-grounded", backend: "local", container: "hub", fixture: fixtureDir },
    });
    cleanups.push(res.metadata.workspace);

    expect(res.output).toContain("done");
    expect(res.metadata.toolCalls).toContain("ask");
    expect((await stat(join(res.metadata.containerPath, ".okh", "okh.yaml"))).isFile()).toBe(true);
  });
});
