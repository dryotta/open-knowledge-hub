import { describe, it, expect } from "vitest";
import { readFile, stat, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { environments } from "../eval/environments.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVAL = join(REPO, "eval");
const exists = async (p: string) => !!(await stat(p).catch(() => null));

async function discoverScenarios() {
  const root = join(EVAL, "scenarios");
  const out: { id: string; relPrompt: string; dir: string }[] = [];
  for (const verb of (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory())) {
    for (const leaf of (await readdir(join(root, verb.name), { withFileTypes: true })).filter((e) => e.isDirectory())) {
      out.push({
        id: `${verb.name}-${leaf.name}`,
        relPrompt: `file://scenarios/${verb.name}/${leaf.name}/prompt.md`,
        dir: join(root, verb.name, leaf.name),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

describe("promptfooconfig.yaml", () => {
  it("references an existing provider and a tests glob", async () => {
    const cfg = parseYaml(await readFile(join(EVAL, "promptfooconfig.yaml"), "utf8"));
    const providerId: string = cfg.providers[0].id;
    expect(providerId.startsWith("file://")).toBe(true);
    expect(providerId).toBe("file://provider/copilotProvider.ts");
    expect(await exists(join(EVAL, providerId.replace("file://", "")))).toBe(true);
    expect(String(cfg.tests)).toContain("scenarios");
  });

  it("uses a single pass-through prompt and a two-level tests glob", async () => {
    const cfg = parseYaml(await readFile(join(EVAL, "promptfooconfig.yaml"), "utf8"));
    expect(Array.isArray(cfg.prompts)).toBe(true);
    expect(cfg.prompts).toHaveLength(1);
    expect(cfg.prompts[0].raw).toBe("{{prompt}}");
    expect(cfg.prompts[0].label).toBe("OKH scenario prompt");
    expect(String(cfg.tests)).toContain("scenarios/*/*/test.yaml");
    // every scenario still has a prompt.md that its `prompt` var points at
    for (const s of await discoverScenarios()) {
      expect(await exists(join(s.dir, "prompt.md"))).toBe(true);
    }
  });
});

describe("scenarios", () => {
  it("all 16 scenarios parse, reference existing fixtures + assertion files, and have judge criteria", async () => {
    const scenarios = await discoverScenarios();
    expect(scenarios.map((s) => s.id)).toEqual([
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

    for (const s of scenarios) {
      const list = parseYaml(await readFile(join(s.dir, "test.yaml"), "utf8"));
      expect(Array.isArray(list)).toBe(true);
      const test = list[0];
      expect(test.description).toBe(s.id);
      expect(test.vars.prompt).toBe(s.relPrompt);
      expect(Object.keys(test.vars).sort()).toEqual(["env", "prompt"]);
      expect(Object.keys(environments)).toContain(test.vars.env);
      expect((await readFile(join(s.dir, "prompt.md"), "utf8")).trim().length).toBeGreaterThan(0);
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