import { describe, it, expect } from "vitest";
import { readFile, stat, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVAL = join(REPO, "eval");
const exists = async (p: string) => !!(await stat(p).catch(() => null));

describe("promptfooconfig.yaml", () => {
  it("references an existing provider and a tests glob", async () => {
    const cfg = parseYaml(await readFile(join(EVAL, "promptfooconfig.yaml"), "utf8"));
    const providerId: string = cfg.providers[0].id;
    expect(providerId.startsWith("file://")).toBe(true);
    expect(providerId).toBe("file://provider/copilotProvider.ts");
    expect(await exists(join(EVAL, providerId.replace("file://", "")))).toBe(true);
    expect(String(cfg.tests)).toContain("scenarios");
  });
});

describe("scenarios", () => {
  it("all 16 scenarios parse, reference existing fixtures + assertion files, and have judge criteria", async () => {
    const dirs = (await readdir(join(EVAL, "scenarios"), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([
      "ask-declines-when-absent",
      "ask-grounded",
      "ask-multi-container",
      "context-assembly",
      "context-includes-skills-tools",
      "learn-integrates",
      "learn-rejects-trivial",
      "onboard-add-existing-folder",
      "onboard-add-github",
      "onboard-create-local",
      "onboard-explains",
      "onboard-phrase",
      "onboard-wake-phrase",
      "reflect-insights",
      "remember-no-conclusions",
      "remember-records",
    ]);

    for (const d of dirs) {
      const list = parseYaml(await readFile(join(EVAL, "scenarios", d, "test.yaml"), "utf8"));
      expect(Array.isArray(list)).toBe(true);
      const test = list[0];
      expect(typeof test.vars.prompt).toBe("string");
      expect(await exists(join(EVAL, String(test.vars.fixture)))).toBe(true);
      // each scenario grades via the Copilot-CLI judge assertion with criteria
      const judges = test.assert.filter(
        (a: { type: string; value?: string }) => a.type === "javascript" && String(a.value).endsWith("judge.ts"),
      );
      expect(judges.length).toBeGreaterThanOrEqual(1);
      const criteria = judges[0].config?.criteria;
      expect(Array.isArray(criteria)).toBe(true);
      expect(criteria.length).toBeGreaterThanOrEqual(1);
      for (const c of criteria) {
        expect(typeof c.id).toBe("string");
        expect(typeof c.text).toBe("string");
      }
      for (const a of test.assert) {
        if (a.type === "javascript") {
          expect(await exists(join(EVAL, String(a.value).replace("file://", "")))).toBe(true);
        }
      }
    }
  });
});