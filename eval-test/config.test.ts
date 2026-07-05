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
  learn: 2,
  remember: 2,
  reflect: 1,
  onboard: 6,
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

describe("scenario configs", () => {
  it("provides 16 per-prompt configs across the expected verb folders", async () => {
    const files = await scenarioFiles();
    expect(files.length).toBe(16);
    const counts: Record<string, number> = {};
    for (const f of files) {
      const verb = f.split("/")[0];
      counts[verb] = (counts[verb] ?? 0) + 1;
    }
    expect(counts).toEqual(EXPECTED_COUNTS);
  });

  it("every config is complete: shared provider, one inline prompt, one env-bound test, judge criteria, existing assertions", async () => {
    const seenDescriptions = new Set<string>();
    for (const file of await scenarioFiles()) {
      const dir = dirname(join(SCENARIOS, file));
      const cfg = parseYaml(await readFile(join(SCENARIOS, file), "utf8"));

      // a unique, descriptive sentence — not a one-word dashed id
      expect(typeof cfg.description, `${file}: description is a string`).toBe("string");
      expect(cfg.description.trim().length).toBeGreaterThan(10);
      expect(cfg.description).toContain(" ");
      expect(seenDescriptions.has(cfg.description)).toBe(false);
      seenDescriptions.add(cfg.description);

      // injects the shared provider (and it exists)
      expect(cfg.providers).toEqual(["file://../shared/provider.ts"]);
      expect(await exists(resolve(dir, "../shared/provider.ts"))).toBe(true);

      // exactly one inline prompt — a bare string (no {{prompt}} var, no label needed)
      expect(Array.isArray(cfg.prompts)).toBe(true);
      expect(cfg.prompts).toHaveLength(1);
      const prompt = cfg.prompts[0];
      expect(typeof prompt, `${file}: prompt is a bare string`).toBe("string");
      expect(prompt.trim().length).toBeGreaterThan(0);
      expect(prompt).not.toContain("{{prompt}}");

      // exactly one test with a known env; no per-test prompt filter (configs run one-by-one)
      expect(Array.isArray(cfg.tests)).toBe(true);
      expect(cfg.tests).toHaveLength(1);
      const test = cfg.tests[0];
      expect(Object.keys(environments)).toContain(test.vars.env);
      expect(test.prompts, `${file}: no prompt filter needed`).toBeUndefined();

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

      // every referenced assertion file exists (resolved relative to the config file)
      for (const a of test.assert) {
        if (a.type === "javascript") {
          expect(await exists(resolve(dir, String(a.value).replace("file://", "")))).toBe(true);
        }
      }
    }
  });
});
