import { describe, it, expect } from "vitest";
import { readFile, stat, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { environments } from "../eval/environments.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVAL = join(REPO, "eval");
const SCENARIOS = join(EVAL, "scenarios");
const exists = async (p: string) => !!(await stat(p).catch(() => null));

/** Expected number of per-prompt config files in each verb folder. */
const EXPECTED_COUNTS: Record<string, number> = {
  ask: 3,
  context: 2,
  ingest: 1,
  learn: 2,
  remember: 2,
  reflect: 1,
  onboard: 7,
  inspect: 1,
  run: 2,
};

/** Every scenario config file (verb/<name>.yaml), skipping the shared/ folder. */
async function scenarioFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const verb of await readdir(SCENARIOS, { withFileTypes: true })) {
    if (!verb.isDirectory() || verb.name === "shared") continue;
    for (const f of await readdir(join(SCENARIOS, verb.name))) {
      if (f.endsWith(".yaml")) out.push(`${verb.name}/${f}`);
    }
  }
  return out.sort();
}

describe("shared provider", () => {
  it("is a provider module that wraps the copilot provider with baked-in defaults", async () => {
    const p = join(SCENARIOS, "shared", "provider.ts");
    expect(await exists(p)).toBe(true);
    const src = await readFile(p, "utf8");
    // extends the real provider (import resolves one level above the shared folder)
    expect(src).toContain("../../provider/copilotProvider.js");
    expect(await exists(resolve(SCENARIOS, "shared", "../../provider/copilotProvider.ts"))).toBe(true);
    // the shared defaults (model + timeout) live here, in one place
    expect(src).toMatch(/model:/);
    expect(src).toMatch(/timeoutMs:/);
  });
});

describe("promptfooconfig.yaml (single default)", () => {
  it("has the {{prompt}} pass-through, the shared provider, and the scenarios glob", async () => {
    const cfg = parseYaml(await readFile(join(EVAL, "promptfooconfig.yaml"), "utf8"));
    expect(cfg.prompts).toEqual(["{{prompt}}"]);
    expect(cfg.providers).toEqual(["file://scenarios/shared/provider.ts"]);
    expect(await exists(join(SCENARIOS, "shared", "provider.ts"))).toBe(true);
    expect(cfg.scenarios).toEqual(["file://scenarios/**/*.yaml"]);
  });
});

describe("scenario configs", () => {
  it("provides 21 scenario files across the expected verb folders", async () => {
    const files = await scenarioFiles();
    expect(files.length).toBe(21);
    const counts: Record<string, number> = {};
    for (const f of files) {
      const verb = f.split("/")[0];
      counts[verb] = (counts[verb] ?? 0) + 1;
    }
    expect(counts).toEqual(EXPECTED_COUNTS);
  });

  it("every file is a one-element scenario list: config.vars(prompt+env), a test with asserts, judge criteria, eval-relative assertion paths", async () => {
    const seenDescriptions = new Set<string>();
    for (const file of await scenarioFiles()) {
      const doc = parseYaml(await readFile(join(SCENARIOS, file), "utf8"));

      // a YAML list with exactly one scenario
      expect(Array.isArray(doc), `${file}: is a YAML list`).toBe(true);
      expect(doc).toHaveLength(1);
      const sc = doc[0];

      // no per-file provider or prompt (they live in promptfooconfig.yaml)
      expect(sc.providers, `${file}: no per-file providers`).toBeUndefined();
      expect(sc.prompts, `${file}: no per-file prompts`).toBeUndefined();

      // description lives on the test (labels the viewer row + is filterable), not the scenario
      expect(sc.description, `${file}: no scenario-level description`).toBeUndefined();

      // exactly one config set with a bare-string prompt (no {{prompt}}) and a known env
      expect(Array.isArray(sc.config)).toBe(true);
      expect(sc.config).toHaveLength(1);
      const vars = sc.config[0].vars;
      expect(vars, `${file}: config[0].vars is defined`).toBeDefined();
      expect(typeof vars.prompt, `${file}: prompt is a bare string`).toBe("string");
      expect(vars.prompt.trim().length).toBeGreaterThan(0);
      expect(vars.prompt).not.toContain("{{prompt}}");
      expect(Object.keys(environments)).toContain(vars.env);

      // exactly one test: only asserts, no per-test vars/prompt filter
      expect(Array.isArray(sc.tests)).toBe(true);
      expect(sc.tests).toHaveLength(1);
      const test = sc.tests[0];
      expect(typeof test.description, `${file}: test description is a string`).toBe("string");
      expect(test.description.trim().length).toBeGreaterThan(10);
      expect(test.description).toContain(" ");
      expect(seenDescriptions.has(test.description)).toBe(false);
      seenDescriptions.add(test.description);
      expect(test.vars, `${file}: env lives in config, not the test`).toBeUndefined();
      expect(test.prompts, `${file}: no prompt filter`).toBeUndefined();
      expect(Array.isArray(test.assert)).toBe(true);

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

      // every javascript assertion path is eval-relative and exists
      for (const a of test.assert) {
        if (a.type === "javascript") {
          const v = String(a.value);
          expect(v.startsWith("file://assertions/"), `${file}: ${v} is eval-relative`).toBe(true);
          expect(v).not.toContain("../");
          expect(await exists(resolve(EVAL, v.replace("file://", "")))).toBe(true);
        }
      }
    }
  });
});
