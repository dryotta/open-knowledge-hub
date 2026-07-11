import { describe, it, expect } from "vitest";
import { readFile, stat, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { environments } from "../eval/environments.js";
import { llmwikiLoader } from "../src/modules/loaders/llmwiki.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVAL = join(REPO, "eval");
const SCENARIOS = join(EVAL, "scenarios");
const exists = async (p: string) => !!(await stat(p).catch(() => null));

/** Expected number of per-prompt config files in each verb folder. */
const EXPECTED_COUNTS: Record<string, number> = {
  ask: 4,
  context: 2,
  ingest: 1,
  initialize: 1,
  learn: 2,
  lint: 1,
  remember: 2,
  reflect: 1,
  onboard: 7,
  inspect: 1,
  run: 2,
  write: 1,
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
  it("provides 25 scenario files across the expected verb folders", async () => {
    const files = await scenarioFiles();
    expect(files.length).toBe(25);
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

  it("multi-turn scenarios have unique turn IDs, valid predecessors, and well-formed terminal", async () => {
    for (const file of await scenarioFiles()) {
      const doc = parseYaml(await readFile(join(SCENARIOS, file), "utf8"));
      const vars = doc[0].config[0].vars;
      if (!vars.turns || !Array.isArray(vars.turns) || vars.turns.length === 0) continue;

      const turns = vars.turns as Array<{ id: string; after: string | string[]; send: string; when?: string }>;

      // All turn IDs must be unique
      const ids = turns.map((t) => t.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size, `${file}: turn IDs must be unique`).toBe(ids.length);

      // All predecessors must reference "start" or a declared turn ID
      const validPreds = new Set(["start", ...ids]);
      for (const t of turns) {
        const afters = Array.isArray(t.after) ? t.after : [t.after];
        for (const a of afters) {
          expect(validPreds.has(a), `${file}: turn "${t.id}" has predecessor "${a}" not in declared IDs`).toBe(true);
        }
      }

      // terminal must exist and terminal.after must reference a declared turn ID
      expect(vars.terminal, `${file}: multi-turn scenario requires terminal`).toBeDefined();
      const terminal = vars.terminal as { after: string; requiredTools?: string[] };
      expect(typeof terminal.after, `${file}: terminal.after is a string`).toBe("string");
      expect(uniqueIds.has(terminal.after), `${file}: terminal.after "${terminal.after}" must be a declared turn ID`).toBe(true);

      // requiredTools shape validation
      if (terminal.requiredTools !== undefined) {
        expect(Array.isArray(terminal.requiredTools), `${file}: terminal.requiredTools is an array`).toBe(true);
        for (const tool of terminal.requiredTools) {
          expect(typeof tool, `${file}: each requiredTool is a string`).toBe("string");
        }
      }
    }
  });
});

describe("llmwiki scenario structured tool expectations", () => {
  async function loadScenario(path: string) {
    const doc = parseYaml(await readFile(join(SCENARIOS, path), "utf8"));
    return doc[0];
  }

  function getToolsCalledConfig(sc: { tests: Array<{ assert: Array<{ type: string; value?: string; config?: Record<string, unknown> }> }> }) {
    const assertion = sc.tests[0].assert.find(
      (a: { type: string; value?: string }) => a.type === "javascript" && String(a.value).includes("tools-called"),
    );
    return assertion?.config as { expect: Array<string | { name: string; arguments?: Record<string, unknown> }>; ordered?: boolean } | undefined;
  }

  function getLlmwikiStateConfig(sc: { tests: Array<{ assert: Array<{ type: string; value?: string; config?: Record<string, unknown> }> }> }) {
    const assertion = sc.tests[0].assert.find(
      (a: { type: string; value?: string }) => a.type === "javascript" && String(a.value).includes("llmwiki-state"),
    );
    return assertion?.config as Record<string, unknown> | undefined;
  }

  it("initialize/llmwiki.yaml uses ordered structured tool expectations with required args", async () => {
    const sc = await loadScenario("initialize/llmwiki.yaml");
    const cfg = getToolsCalledConfig(sc);
    expect(cfg, "tools-called config must exist").toBeDefined();
    expect(cfg!.ordered, "initialize must use ordered expectations").toBe(true);

    const expectations = cfg!.expect;
    expect(expectations.length).toBeGreaterThanOrEqual(3);

    // First: module initialize with container/module/skill args
    const initExp = expectations[0] as { name: string; arguments?: Record<string, unknown> };
    expect(initExp.name).toBe("run");
    expect(initExp.arguments).toBeDefined();
    expect(initExp.arguments!.container).toBe("wiki-hub");
    expect(initExp.arguments!.module).toBe("new-wiki");
    expect(initExp.arguments!.skill).toBe("initialize");

    // Second: shared grilling (no container/module required)
    const grillExp = expectations[1] as { name: string; arguments?: Record<string, unknown> };
    expect(grillExp.name).toBe("run");
    expect(grillExp.arguments).toBeDefined();
    expect(grillExp.arguments!.skill).toBe("grilling");
    // shared skill must not require container/module keys
    expect(grillExp.arguments).not.toHaveProperty("container");
    expect(grillExp.arguments).not.toHaveProperty("module");

    // Last: sync
    const syncExp = expectations[expectations.length - 1] as { name: string } | string;
    const syncName = typeof syncExp === "string" ? syncExp : syncExp.name;
    expect(syncName).toBe("sync");
  });

  it("initialize/llmwiki.yaml has llmwiki-state assertion config", async () => {
    const sc = await loadScenario("initialize/llmwiki.yaml");
    const cfg = getLlmwikiStateConfig(sc);
    expect(cfg, "llmwiki-state assertion must exist").toBeDefined();
    expect(cfg!.module).toBe("new-wiki");
    expect(cfg!.requiredIndexText).toBeDefined();
    const indexText = cfg!.requiredIndexText as string[];
    expect(indexText).toContain("backend developers");
    expect(indexText).toContain("product roadmaps");
    expect(indexText).toContain("concept");
    expect(indexText).toContain("synthesis");
    expect(cfg!.requiredGroupIndexes).toBeDefined();
    const groupIndexes = cfg!.requiredGroupIndexes as string[];
    expect(groupIndexes).toContain("concepts/index.md");
    expect(groupIndexes).toContain("entities/index.md");
    expect(groupIndexes).toContain("summaries/index.md");
    expect(groupIndexes).toContain("syntheses/index.md");
    expect(cfg!.noContentPages).toBe(true);
  });

  it("initialize/llmwiki.yaml scope-confirmed turn has after:sources, no when guard, and agreement/build send text", async () => {
    const sc = await loadScenario("initialize/llmwiki.yaml");
    const turns = sc.config[0].vars.turns as Array<{ id: string; after: string | string[]; send: string; when?: string }>;
    const scopeTurn = turns.find((t) => t.id === "scope-confirmed");
    expect(scopeTurn, "scope-confirmed turn must exist").toBeDefined();
    // Must be unguarded — no `when` property
    expect(scopeTurn!.when, "scope-confirmed must not have a when guard").toBeUndefined();
    // Must follow exactly sources
    const after = Array.isArray(scopeTurn!.after) ? scopeTurn!.after : [scopeTurn!.after];
    expect(after).toEqual(["sources"]);
    // Send text must contain the agreement and build instruction
    expect(scopeTurn!.send).toMatch(/decisions are final/i);
    expect(scopeTurn!.send).toMatch(/build.*empty structure|empty structure.*build/i);
  });

  it("initialize/llmwiki.yaml sync-confirmed turn is unguarded and follows scope-confirmed with correct send text", async () => {
    const sc = await loadScenario("initialize/llmwiki.yaml");
    const turns = sc.config[0].vars.turns as Array<{ id: string; after: string | string[]; send: string; when?: string }>;
    const syncTurn = turns.find((t) => t.id === "sync-confirmed");
    expect(syncTurn, "sync-confirmed turn must exist").toBeDefined();
    // Must be unguarded — no `when` property
    expect(syncTurn!.when, "sync-confirmed must not have a when guard").toBeUndefined();
    // Must follow exactly scope-confirmed
    const after = Array.isArray(syncTurn!.after) ? syncTurn!.after : [syncTurn!.after];
    expect(after).toEqual(["scope-confirmed"]);
    // Send text must be the explicit sync authorization
    expect(syncTurn!.send.trim()).toBe("Yes, sync those changes now.");
  });

  it("write/into-wiki.yaml uses ordered structured tool expectations", async () => {
    const sc = await loadScenario("write/into-wiki.yaml");
    const cfg = getToolsCalledConfig(sc);
    expect(cfg, "tools-called config must exist").toBeDefined();
    expect(cfg!.ordered, "write must use ordered expectations").toBe(true);

    const expectations = cfg!.expect;
    expect(expectations.length).toBeGreaterThanOrEqual(4);

    // 1: module run write
    const writeExp = expectations[0] as { name: string; arguments?: Record<string, unknown> };
    expect(writeExp.name).toBe("run");
    expect(writeExp.arguments!.container).toBe("wiki-hub");
    expect(writeExp.arguments!.module).toBe("wiki");
    expect(writeExp.arguments!.skill).toBe("write");

    // 2: shared okf-writer (no container/module)
    const writerExp = expectations[1] as { name: string; arguments?: Record<string, unknown> };
    expect(writerExp.name).toBe("run");
    expect(writerExp.arguments!.skill).toBe("okf-writer");
    expect(writerExp.arguments).not.toHaveProperty("container");
    expect(writerExp.arguments).not.toHaveProperty("module");

    // 3: inspect
    const inspectExp = expectations[2] as { name: string; arguments?: Record<string, unknown> };
    expect(inspectExp.name).toBe("inspect");
    expect(inspectExp.arguments!.container).toBe("wiki-hub");
    expect(inspectExp.arguments!.module).toBe("wiki");

    // 4: sync
    const syncExp = expectations[3] as { name: string; arguments?: Record<string, unknown> };
    expect(typeof syncExp === "string" ? syncExp : syncExp.name).toBe("sync");
    if (typeof syncExp !== "string") {
      expect(syncExp.arguments!.container).toBe("wiki-hub");
    }
  });

  it("write/into-wiki.yaml has llmwiki-state assertion config for expectedNewPage", async () => {
    const sc = await loadScenario("write/into-wiki.yaml");
    const cfg = getLlmwikiStateConfig(sc);
    expect(cfg, "llmwiki-state assertion must exist").toBeDefined();
    const page = cfg!.expectedNewPage as { folder: string; type: string; terms: string[] };
    expect(page.folder).toBe("concepts");
    expect(page.type).toBe("concept");
    expect(page.terms.some((t: string) => /kv|cache/i.test(t))).toBe(true);
    expect(cfg!.requireIndexAndLogChanged).toBe(true);
    expect(cfg!.requireCleanHealth).toBe(true);
  });

  it("lint/wiki-health.yaml uses ordered structured tool expectations", async () => {
    const sc = await loadScenario("lint/wiki-health.yaml");
    const cfg = getToolsCalledConfig(sc);
    expect(cfg, "tools-called config must exist").toBeDefined();
    expect(cfg!.ordered, "lint must use ordered expectations").toBe(true);

    const expectations = cfg!.expect;
    expect(expectations.length).toBeGreaterThanOrEqual(3);

    // 1: module run lint
    const lintExp = expectations[0] as { name: string; arguments?: Record<string, unknown> };
    expect(lintExp.name).toBe("run");
    expect(lintExp.arguments!.container).toBe("health-hub");
    expect(lintExp.arguments!.module).toBe("wiki");
    expect(lintExp.arguments!.skill).toBe("lint");

    // inspect must appear
    const inspectExp = expectations.find(
      (e: string | { name: string }) => (typeof e === "string" ? e : e.name) === "inspect",
    ) as { name: string; arguments?: Record<string, unknown> };
    expect(inspectExp).toBeDefined();
    expect(inspectExp.arguments!.container).toBe("health-hub");

    // sync must appear last
    const lastExp = expectations[expectations.length - 1] as { name: string } | string;
    expect(typeof lastExp === "string" ? lastExp : lastExp.name).toBe("sync");
  });

  it("ask/llmwiki-compounding.yaml uses ordered structured tool expectations", async () => {
    const sc = await loadScenario("ask/llmwiki-compounding.yaml");
    const cfg = getToolsCalledConfig(sc);
    expect(cfg, "tools-called config must exist").toBeDefined();
    expect(cfg!.ordered, "compounding must use ordered expectations").toBe(true);

    const expectations = cfg!.expect;
    expect(expectations.length).toBeGreaterThanOrEqual(4);

    // 1: module run write
    const writeExp = expectations[0] as { name: string; arguments?: Record<string, unknown> };
    expect(writeExp.name).toBe("run");
    expect(writeExp.arguments!.container).toBe("wiki-hub");
    expect(writeExp.arguments!.module).toBe("wiki");
    expect(writeExp.arguments!.skill).toBe("write");

    // 2: shared okf-writer (no container/module)
    const writerExp = expectations[1] as { name: string; arguments?: Record<string, unknown> };
    expect(writerExp.name).toBe("run");
    expect(writerExp.arguments!.skill).toBe("okf-writer");
    expect(writerExp.arguments).not.toHaveProperty("container");
    expect(writerExp.arguments).not.toHaveProperty("module");

    // 3: inspect
    const inspectExp = expectations[2] as { name: string; arguments?: Record<string, unknown> };
    expect(inspectExp.name).toBe("inspect");

    // 4: sync
    const syncExp = expectations[3] as { name: string; arguments?: Record<string, unknown> };
    expect(typeof syncExp === "string" ? syncExp : syncExp.name).toBe("sync");
  });

  it("ask/llmwiki-compounding.yaml has llmwiki-state config for synthesis", async () => {
    const sc = await loadScenario("ask/llmwiki-compounding.yaml");
    const cfg = getLlmwikiStateConfig(sc);
    expect(cfg, "llmwiki-state assertion must exist").toBeDefined();
    const page = cfg!.expectedNewPage as { folder: string; type: string; terms: string[] };
    expect(page.folder).toBe("syntheses");
    expect(page.type).toBe("synthesis");
    expect(page.terms.some((t: string) => /attention/i.test(t))).toBe(true);
    expect(page.terms.some((t: string) => /transformer/i.test(t))).toBe(true);
    expect(cfg!.requireIndexAndLogChanged).toBe(true);
    expect(cfg!.requireCleanHealth).toBe(true);
  });

  function getJudgeCriteria(sc: {
    tests: Array<{
      assert: Array<{ type: string; value?: string; config?: { criteria?: Array<Record<string, unknown>> } }>;
    }>;
  }) {
    const judgeAssert = sc.tests[0].assert.find(
      (a: { type: string; value?: string }) => a.type === "javascript" && String(a.value).endsWith("judge.ts"),
    );
    return judgeAssert?.config?.criteria as Array<{ id: string; text: string; required?: boolean; advisory?: unknown }> | undefined;
  }

  const MECHANICAL_IDS: Record<string, string[]> = {
    "initialize/llmwiki.yaml": ["ran-initialize", "used-grilling", "persisted-via-sync"],
    "write/into-wiki.yaml": ["ran-write", "persisted-via-sync"],
    "lint/wiki-health.yaml": ["ran-lint"],
    "ask/llmwiki-compounding.yaml": ["ran-write", "persisted-via-sync"],
  };

  it("mechanical judge criteria use required:false (not advisory:true) in all four llmwiki scenarios", async () => {
    for (const [file, ids] of Object.entries(MECHANICAL_IDS)) {
      const sc = await loadScenario(file);
      const criteria = getJudgeCriteria(sc);
      expect(criteria, `${file}: judge criteria must exist`).toBeDefined();
      for (const id of ids) {
        const c = criteria!.find((c) => c.id === id);
        expect(c, `${file}: criterion "${id}" must exist`).toBeDefined();
        expect(c!.required, `${file}: criterion "${id}" must have required:false`).toBe(false);
      }
    }
  });

  it("no judge criterion in the four llmwiki scenarios uses the unsupported advisory key", async () => {
    for (const file of Object.keys(MECHANICAL_IDS)) {
      const sc = await loadScenario(file);
      const criteria = getJudgeCriteria(sc);
      expect(criteria, `${file}: judge criteria must exist`).toBeDefined();
      for (const c of criteria!) {
        expect(c.advisory, `${file}: criterion "${c.id}" must not have unsupported advisory key`).toBeUndefined();
      }
    }
  });
});

describe("llmwiki fixture schema", () => {
  const FIXTURE_WIKI = join(EVAL, "fixtures", "wiki-hub", "wiki");

  it("root index.md declares concepts/, entities/, syntheses/ folders and concept, entity, synthesis types", async () => {
    const content = await readFile(join(FIXTURE_WIKI, "index.md"), "utf8");
    // Declared group folders
    expect(content).toMatch(/concepts\//);
    expect(content).toMatch(/entities\//);
    expect(content).toMatch(/syntheses\//);
    // Declared concept types
    expect(content).toMatch(/\bconcept\b/);
    expect(content).toMatch(/\bentity\b/);
    expect(content).toMatch(/\bsynthesis\b/);
  });

  it("syntheses/index.md exists as a group stub with heading and description, no concept frontmatter", async () => {
    const synthPath = join(FIXTURE_WIKI, "syntheses", "index.md");
    expect(await exists(synthPath), "syntheses/index.md must exist").toBe(true);
    const content = await readFile(synthPath, "utf8");
    // Has heading
    expect(content).toMatch(/^#\s+Syntheses/m);
    // Has durable explanation description
    expect(content).toMatch(/durable.*explanation.*connecting|connecting.*multiple.*wiki/i);
    // No concept frontmatter (no type: field in YAML block)
    expect(content).not.toMatch(/^---[\s\S]*?type:/m);
  });
});

describe("state-driven linear conversations — cold-start", () => {
  async function loadScenario(path: string) {
    const doc = parseYaml(await readFile(join(SCENARIOS, path), "utf8"));
    return doc[0];
  }

  it("cold-start chain is start→wake-phrase→container-choice→create-confirmed→wrap-up", async () => {
    const sc = await loadScenario("onboard/cold-start-conversation.yaml");
    const turns = sc.config[0].vars.turns as Array<{ id: string; after: string | string[]; when?: string; send: string }>;
    const ids = turns.map((t) => t.id);
    expect(ids).toEqual(["wake-phrase", "container-choice", "create-confirmed", "wrap-up"]);
    // Verify the after chain
    expect(turns[0]!.after).toBe("start");
    expect(turns[1]!.after).toBe("wake-phrase");
    expect(turns[2]!.after).toBe("container-choice");
    expect(turns[3]!.after).toBe("create-confirmed");
  });

  it("ALL cold-start turns are unguarded (no when property)", async () => {
    const sc = await loadScenario("onboard/cold-start-conversation.yaml");
    const turns = sc.config[0].vars.turns as Array<{ id: string; when?: string }>;
    for (const t of turns) {
      expect(t.when, `turn "${t.id}" must not have a when guard`).toBeUndefined();
    }
  });
});

describe("state-driven linear conversations — llmwiki", () => {
  async function loadScenario(path: string) {
    const doc = parseYaml(await readFile(join(SCENARIOS, path), "utf8"));
    return doc[0];
  }

  it("llmwiki linear chain is start→purpose→goals→scope→template→tags→sources→scope-confirmed→sync-confirmed", async () => {
    const sc = await loadScenario("initialize/llmwiki.yaml");
    const turns = sc.config[0].vars.turns as Array<{ id: string; after: string | string[]; when?: string }>;
    const ids = turns.map((t) => t.id);
    expect(ids).toEqual(["purpose", "goals", "scope", "template", "tags", "sources", "scope-confirmed", "sync-confirmed"]);
    // Verify the linear after chain
    expect(turns[0]!.after).toBe("start");
    expect(turns[1]!.after).toBe("purpose");
    expect(turns[2]!.after).toBe("goals");
    expect(turns[3]!.after).toBe("scope");
    expect(turns[4]!.after).toBe("template");
    expect(turns[5]!.after).toBe("tags");
    expect(turns[6]!.after).toBe("sources");
    expect(turns[7]!.after).toBe("scope-confirmed");
  });

  it("ALL llmwiki turns are unguarded (no when property)", async () => {
    const sc = await loadScenario("initialize/llmwiki.yaml");
    const turns = sc.config[0].vars.turns as Array<{ id: string; when?: string }>;
    for (const t of turns) {
      expect(t.when, `turn "${t.id}" must not have a when guard`).toBeUndefined();
    }
  });
});

describe("wiki-hub fixture health", () => {
  const FIXTURE_WIKI = join(EVAL, "fixtures", "wiki-hub", "wiki");

  it("wiki-hub/wiki is clean in all four health arrays", async () => {
    const h = await llmwikiLoader.health!(FIXTURE_WIKI);
    expect(h.orphans, "no orphans").toEqual([]);
    expect(h.danglingLinks, "no dangling links").toEqual([]);
    expect(h.uncataloged, "no uncataloged pages").toEqual([]);
    expect(h.missingType, "no missing types").toEqual([]);
  });
});

describe("health-hub lint fixture", () => {
  const HEALTH_WIKI = join(EVAL, "fixtures", "health-hub", "wiki");

  it("health-hub/wiki has a valid module manifest", async () => {
    const manifest = parseYaml(await readFile(join(HEALTH_WIKI, ".okh", "module.yaml"), "utf8"));
    expect(manifest.type).toBe("llmwiki");
  });

  it("health-hub/wiki has orphan concepts/positional-encoding.md", async () => {
    const h = await llmwikiLoader.health!(HEALTH_WIKI);
    expect(h.orphans).toContain("concepts/positional-encoding.md");
  });

  it("health-hub/wiki has dangling link concepts/attention.md→concepts/kv-cache.md", async () => {
    const h = await llmwikiLoader.health!(HEALTH_WIKI);
    const dangling = h.danglingLinks.map((l) => `${l.from}->${l.to}`);
    expect(dangling).toContain("concepts/attention.md->concepts/kv-cache.md");
  });
});

describe("ask/across-hubs — no-fabrication criterion", () => {
  it("states complete fixture-backed fact boundary, allows coverage-gap/inference, rejects unsupported claims presented as known facts", async () => {
    const doc = parseYaml(await readFile(join(SCENARIOS, "ask/across-hubs.yaml"), "utf8"));
    const sc = doc[0];
    const judgeAssert = sc.tests[0].assert.find(
      (a: { type: string; value?: string }) =>
        a.type === "javascript" && String(a.value).endsWith("judge.ts"),
    );
    const criteria = judgeAssert?.config?.criteria as
      | Array<{ id: string; text: string; required?: boolean }>
      | undefined;
    const crit = criteria?.find((c) => c.id === "no-fabrication");
    expect(crit, "no-fabrication criterion must exist").toBeDefined();
    const text = crit!.text;

    // Must name fixture-backed facts present in both hubs
    expect(text, "must reference signed session tokens").toMatch(/signed session token/i);
    // Must name kb-hub-specific facts
    expect(text, "must reference issued at login (kb-hub fact)").toMatch(/issued at login/i);
    expect(text, "must reference 24-hour expiry (kb-hub fact)").toMatch(/24.hour/i);
    expect(text, "must reference rotate on use (kb-hub fact)").toMatch(/rotate on use/i);
    // Must name memory evidence with the fixture-backed >60-second threshold
    expect(text, "must reference clock skew or drift (memory evidence)").toMatch(/clock skew|clock drift/i);
    expect(text, "must name fixture-backed >60-second drift threshold").toMatch(/greater than 60/i);

    // Must explicitly allow coverage-gap statements
    expect(text, "must explicitly allow coverage-gap statements").toMatch(/coverage.gap/i);
    // Must explicitly allow clearly labeled inference or synthesis
    expect(text, "must explicitly allow labeled inference or synthesis").toMatch(/inference|synthesis/i);

    // Must state that unsupported details presented as source-backed facts should fail
    expect(text, "must reject unsupported technical details presented as known facts").toMatch(/unsupported/i);
    // Must state that specific technical details remain disallowed even when labeled as inference/synthesis
    expect(text, "must state specific technical details disallowed even when labeled as inference/synthesis").toMatch(
      /even when labeled/i,
    );

    // Criterion must remain required (not required:false)
    expect(crit!.required, "no-fabrication must not be required:false").not.toBe(false);
  });
});

describe("lint scenario uses health environment", () => {
  async function loadScenario(path: string) {
    const doc = parseYaml(await readFile(join(SCENARIOS, path), "utf8"));
    return doc[0];
  }

  it("lint/wiki-health.yaml uses env health and container health-hub in prompt", async () => {
    const sc = await loadScenario("lint/wiki-health.yaml");
    const vars = sc.config[0].vars;
    expect(vars.env).toBe("health");
    expect(vars.prompt).toContain("health-hub");
  });

  it("lint/wiki-health.yaml tool expectations reference container health-hub", async () => {
    const sc = await loadScenario("lint/wiki-health.yaml");
    const assertion = sc.tests[0].assert.find(
      (a: { type: string; value?: string }) => a.type === "javascript" && String(a.value).includes("tools-called"),
    );
    const cfg = assertion?.config as { expect: Array<{ name: string; arguments?: Record<string, unknown> }> };
    const lintExp = cfg.expect[0] as { name: string; arguments?: Record<string, unknown> };
    expect(lintExp.arguments!.container).toBe("health-hub");
    const inspectExp = cfg.expect.find(
      (e: { name: string; arguments?: Record<string, unknown> }) => e.name === "inspect",
    );
    expect(inspectExp!.arguments!.container).toBe("health-hub");
  });
});
