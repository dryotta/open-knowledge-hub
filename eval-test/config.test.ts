import { describe, it, expect } from "vitest";
import { readFile, stat, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { environments } from "../eval/environments.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVAL = join(REPO, "eval");
const exists = async (p: string) => !!(await stat(p).catch(() => null));

/** Expected number of tests in each grouped scenario file. */
const EXPECTED_COUNTS: Record<string, number> = {
  "ask.yaml": 3,
  "context.yaml": 2,
  "learn.yaml": 2,
  "remember.yaml": 2,
  "reflect.yaml": 1,
  "onboard-getting-started.yaml": 3,
  "onboard-add-create.yaml": 3,
};

async function loadAllTests(): Promise<{ files: string[]; tests: { file: string; test: any }[] }> {
  const root = join(EVAL, "scenarios");
  const files = (await readdir(root)).filter((f) => f.endsWith(".yaml")).sort();
  const tests: { file: string; test: any }[] = [];
  for (const f of files) {
    const list = parseYaml(await readFile(join(root, f), "utf8"));
    expect(Array.isArray(list), `${f} is a list of tests`).toBe(true);
    for (const t of list) tests.push({ file: f, test: t });
  }
  return { files, tests };
}

describe("promptfooconfig.yaml", () => {
  it("references an existing provider and the grouped tests glob", async () => {
    const cfg = parseYaml(await readFile(join(EVAL, "promptfooconfig.yaml"), "utf8"));
    const providerId: string = cfg.providers[0].id;
    expect(providerId).toBe("file://provider/copilotProvider.ts");
    expect(await exists(join(EVAL, providerId.replace("file://", "")))).toBe(true);
    expect(String(cfg.tests)).toContain("scenarios/*.yaml");
  });

  it("uses a single pass-through prompt", async () => {
    const cfg = parseYaml(await readFile(join(EVAL, "promptfooconfig.yaml"), "utf8"));
    expect(Array.isArray(cfg.prompts)).toBe(true);
    expect(cfg.prompts).toHaveLength(1);
    expect(cfg.prompts[0].raw).toBe("{{prompt}}");
    expect(cfg.prompts[0].label).toBe("OKH scenario prompt");
  });
});

describe("scenarios", () => {
  it("groups 16 tests across the expected files", async () => {
    const { files, tests } = await loadAllTests();
    expect(files).toEqual(Object.keys(EXPECTED_COUNTS).sort());
    const counts: Record<string, number> = {};
    for (const { file } of tests) counts[file] = (counts[file] ?? 0) + 1;
    expect(counts).toEqual(EXPECTED_COUNTS);
    expect(tests.length).toBe(16);
  });

  it("every test has a descriptive description, an inline prompt, a valid env, judge criteria, and existing assertion files", async () => {
    const { tests } = await loadAllTests();
    const seenDescriptions = new Set<string>();
    for (const { file, test } of tests) {
      // description: a unique, descriptive sentence — not a one-word dashed id
      expect(typeof test.description, `${file}: description is a string`).toBe("string");
      expect(test.description.trim().length).toBeGreaterThan(10);
      expect(test.description).toContain(" ");
      expect(test.description, `${file}: "${test.description}" looks like a dashed id`).not.toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
      expect(seenDescriptions.has(test.description)).toBe(false);
      seenDescriptions.add(test.description);

      // vars: exactly { env, prompt }; prompt is inline (not a file ref); env is known
      expect(Object.keys(test.vars).sort()).toEqual(["env", "prompt"]);
      expect(Object.keys(environments)).toContain(test.vars.env);
      expect(typeof test.vars.prompt).toBe("string");
      expect(test.vars.prompt.trim().length).toBeGreaterThan(0);
      expect(test.vars.prompt).not.toContain("file://");

      // judge criteria present and well-formed
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

      // every referenced assertion file exists
      for (const a of test.assert) {
        if (a.type === "javascript") {
          expect(await exists(join(EVAL, String(a.value).replace("file://", "")))).toBe(true);
        }
      }
    }
  });
});
