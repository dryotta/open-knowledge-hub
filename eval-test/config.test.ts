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
    expect(await exists(join(REPO, providerId.replace("file://", "")))).toBe(true);
    expect(cfg.defaultTest.options.provider).toBeTruthy();
    expect(String(cfg.tests)).toContain("scenarios");
  });
});

describe("scenarios", () => {
  it("all 8 scenarios parse, reference existing fixtures + assertion files, and have a rubric", async () => {
    const dirs = (await readdir(join(EVAL, "scenarios"), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([
      "ask-declines-when-absent",
      "ask-grounded",
      "context-assembly",
      "learn-integrates",
      "learn-rejects-trivial",
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
      const rubrics = test.assert.filter((a: { type: string }) => a.type === "llm-rubric");
      expect(rubrics.length).toBeGreaterThanOrEqual(1);
      for (const a of test.assert) {
        if (a.type === "javascript") {
          expect(await exists(join(REPO, String(a.value).replace("file://", "")))).toBe(true);
        }
      }
    }
  });
});