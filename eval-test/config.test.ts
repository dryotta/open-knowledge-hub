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
  remember: 3,
  reflect: 1,
  onboard: 7,
  inspect: 1,
  run: 3,
  write: 1,
  todo: 1,
  todos: 1,
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
    // the shared defaults (model + timeout + transient-process retry) live here, in one place
    expect(src).toMatch(/model:/);
    expect(src).toMatch(/timeoutMs:/);
    expect(src).toMatch(/maxAttempts:\s*2/);
  });
});

describe("deterministic custom, context, and ingest scenarios", () => {
  async function loadScenario(path: string) {
    const doc = parseYaml(await readFile(join(SCENARIOS, path), "utf8"));
    return doc[0];
  }

  it("custom cook uses structured routing and fixture-backed response checks", async () => {
    const sc = await loadScenario("run/custom-skill.yaml");
    const assertions = sc.tests[0].assert as Array<{ value?: string; config?: Record<string, unknown> }>;
    const tools = assertions.find((a) => String(a.value).endsWith("tools-called.ts"));
    expect(tools?.config?.expect).toEqual([
      expect.objectContaining({
        name: "run",
        arguments: { container: "custom-hub", module: "recipes", skill: "cook" },
      }),
    ]);
    const transcriptAssert = assertions.find((a) => String(a.value).endsWith("transcript.ts"));
    expect(transcriptAssert?.config?.mustContain).toEqual(expect.arrayContaining(["flour", "milk", "egg"]));
    expect(assertions.some((a) => String(a.value).endsWith("judge.ts"))).toBe(false);
    expect(sc.config[0].vars.prompt).toMatch(/"cook" skill/i);
  });

  it("login context selects auth evidence without selecting unrelated utilities", async () => {
    const sc = await loadScenario("context/login-task.yaml");
    const assertion = sc.tests[0].assert.find(
      (a: { value?: string }) => String(a.value).endsWith("working-set-selection.ts"),
    );
    expect(assertion.config.required).toEqual(expect.arrayContaining([
      "kb/auth\\.md",
      "mem/2026-01-01\\.md",
      "mem/2026-02-15\\.md",
    ]));
    expect(assertion.config.forbidden).toEqual(expect.arrayContaining([
      "engineering/testing/debugging/SKILL\\.md",
      "tools/csv2json/README\\.md",
    ]));
    expect(sc.config[0].vars.prompt).toMatch(/new implementation work, not an existing\s+failure investigation/i);
    expect(sc.tests[0].assert.some((a: { value?: string }) => String(a.value).endsWith("judge.ts"))).toBe(false);
  });

  it("ingest uses structured skill routing plus deterministic artifact checks", async () => {
    const sc = await loadScenario("ingest/into-existing-module.yaml");
    const assertions = sc.tests[0].assert as Array<{ value?: string; config?: Record<string, unknown> }>;
    const tools = assertions.find((a) => String(a.value).endsWith("tools-called.ts"));
    expect(tools?.config?.ordered).toBe(true);
    expect(tools?.config?.expect).toEqual([
      expect.objectContaining({ name: "run", arguments: { skill: "ingest" } }),
      expect.objectContaining({ name: "run", arguments: { container: "health-hub", module: "health", skill: "learn" } }),
      expect.objectContaining({ name: "sync", arguments: { container: "health-hub" } }),
    ]);
    expect(tools?.config?.forbid).toEqual([
      expect.objectContaining({ name: "run", arguments: { skill: "initialize" } }),
      expect.objectContaining({
        name: "run",
        turn: 1,
        arguments: expect.objectContaining({ skill: "learn" }),
      }),
      expect.objectContaining({ name: "sync", turn: 1 }),
    ]);
    expect(assertions.map((a) => a.value)).toEqual(expect.arrayContaining([
      "file://assertions/okf-valid.ts",
      "file://assertions/source-retained.ts",
    ]));
    expect(assertions.some((a) => String(a.value).endsWith("judge.ts"))).toBe(false);
    expect(sc.config[0].vars.prompt).toMatch(/shared "ingest" skill/i);
    expect(sc.config[0].vars.turns).toEqual([
      expect.objectContaining({ id: "routing-confirmed", after: "start" }),
    ]);
    expect(sc.config[0].vars.terminal).toMatchObject({
      after: "routing-confirmed",
      requiredTools: ["run", "sync"],
    });
    expect((tools?.config?.expect as Array<{ turn?: number }>).map((entry) => entry.turn)).toEqual([1, 2, 2]);
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
  it("provides 29 scenario files across the expected verb folders", async () => {
    const files = await scenarioFiles();
    expect(files.length).toBe(29);
    const counts: Record<string, number> = {};
    for (const f of files) {
      const verb = f.split("/")[0];
      counts[verb] = (counts[verb] ?? 0) + 1;
    }
    expect(counts).toEqual(EXPECTED_COUNTS);
  });

  it("every file is a one-element scenario list with natural prompts and valid assertions", async () => {
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
      const userMessages = [
        vars.prompt,
        ...((Array.isArray(vars.turns) ? vars.turns : []) as Array<{ send?: unknown }>)
          .map((turn) => turn.send)
          .filter((send): send is string => typeof send === "string"),
      ];
      for (const message of userMessages) {
        expect(message, `${file}: prompt should not tell the agent which MCP interface to use`)
          .not.toMatch(/\bMCP\b/i);
        expect(message, `${file}: prompt should request user intent, not invoke the onboard tool`)
          .not.toMatch(/\brun\s+onboard\b/i);
        expect(message, `${file}: sync behavior comes from OKH policy, not the user prompt`)
          .not.toMatch(/\bsync\b/i);
        expect(message, `${file}: prompts should not expose tool arguments`)
          .not.toMatch(/\bapply\s*:\s*true\b/i);
      }

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

      // Judge criteria are optional when deterministic assertions fully cover the case.
      const judges = test.assert.filter(
        (a: { type: string; value?: string }) => a.type === "javascript" && String(a.value).endsWith("judge.ts"),
      );
      expect(judges.length).toBeLessThanOrEqual(1);
      if (judges.length === 1) {
        const criteria = judges[0].config?.criteria;
        expect(Array.isArray(criteria)).toBe(true);
        expect(criteria.length).toBeGreaterThanOrEqual(1);
        for (const c of criteria) {
          expect(typeof c.id).toBe("string");
          expect(typeof c.text).toBe("string");
        }
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
      const terminal = vars.terminal as { after: string; requiredTools?: string[]; finalTool?: string };
      expect(typeof terminal.after, `${file}: terminal.after is a string`).toBe("string");
      expect(uniqueIds.has(terminal.after), `${file}: terminal.after "${terminal.after}" must be a declared turn ID`).toBe(true);

      // requiredTools shape validation
      if (terminal.requiredTools !== undefined) {
        expect(Array.isArray(terminal.requiredTools), `${file}: terminal.requiredTools is an array`).toBe(true);
        for (const tool of terminal.requiredTools) {
          expect(typeof tool, `${file}: each requiredTool is a string`).toBe("string");
        }
      }
      if (terminal.finalTool !== undefined) {
        expect(typeof terminal.finalTool, `${file}: terminal.finalTool is a string`).toBe("string");
        expect(terminal.finalTool.length, `${file}: terminal.finalTool is non-empty`).toBeGreaterThan(0);
      }
    }
  });
});

describe("scenario routing contracts", () => {
  async function loadScenario(path: string) {
    const doc = parseYaml(await readFile(join(SCENARIOS, path), "utf8"));
    return doc[0];
  }

  function toolsConfig(sc: {
    tests: Array<{
      assert: Array<{ type: string; value?: string; config?: Record<string, unknown> }>;
    }>;
  }) {
    return sc.tests[0].assert.find(
      (assertion) => assertion.type === "javascript" && String(assertion.value).endsWith("tools-called.ts"),
    )?.config as {
      expect: Array<string | { name: string; arguments?: Record<string, unknown> }>;
      forbid?: Array<string | { name: string; arguments?: Record<string, unknown> }>;
      ordered?: boolean;
    };
  }

  it.each([
    ["remember/todo.yaml", "remember"],
    ["todo/complete.yaml", "todo"],
  ])("%s routes natural-language todo work through the memory skill", async (file, skill) => {
    const scenario = await loadScenario(file);
    const cfg = toolsConfig(scenario);
    expect(cfg.ordered).toBe(true);
    expect(cfg.expect[0]).toMatchObject({
      name: "run",
      arguments: { container: "kb-hub", module: "mem", skill },
    });
    expect(cfg.expect.at(-1)).toMatchObject({
      name: "sync",
      arguments: { container: "kb-hub" },
    });
    expect(scenario.config[0].vars.terminal.finalTool).toBe("sync");
    const assertionValues = scenario.tests[0].assert.map((assertion: { value?: string }) => assertion.value);
    expect(assertionValues).toContain("file://assertions/todo-apply-sync.ts");
    expect(assertionValues).toContain("file://assertions/todo-module-change.ts");
    expect(assertionValues).not.toContain("file://assertions/judge.ts");
  });

  it("todo/complete asks for the module workflow without naming implementation steps", async () => {
    const scenario = await loadScenario("todo/complete.yaml");
    const prompt = scenario.config[0].vars.prompt as string;
    expect(prompt).toMatch(/todo workflow/i);
    expect(prompt).toMatch(/"mem" memory module/i);
    expect(prompt).not.toMatch(/\bsync\b|apply\s*:\s*true|\bMCP\b/i);
  });

  it.each([
    ["learn/useful-fact.yaml", "git-hub"],
    ["learn/trivial-fact.yaml", "kb-hub"],
  ])("%s targets the knowledge module's learn skill", async (file, container) => {
    const cfg = toolsConfig(await loadScenario(file));
    expect(cfg.expect[0]).toMatchObject({
      name: "run",
      arguments: { container, module: "kb", skill: "learn" },
    });
  });

  describe("live-run regression contracts", () => {
    async function loadScenario(path: string) {
      const doc = parseYaml(await readFile(join(SCENARIOS, path), "utf8"));
      return doc[0];
    }

    it("answerable ask explicitly requests and deterministically validates a source citation", async () => {
      const sc = await loadScenario("ask/answerable.yaml");
      expect(sc.config[0].vars.prompt).toMatch(/cite the source concept path/i);
      const assertions = sc.tests[0].assert as Array<{ value?: string; config?: Record<string, unknown> }>;
      const transcriptAssert = assertions.find((a) => String(a.value).endsWith("transcript.ts"));
      expect(transcriptAssert?.config?.source).toBe("final-message");
      const mustContain = transcriptAssert?.config?.mustContain as string[];
      const mustNotContain = transcriptAssert?.config?.mustNotContain as string[];
      expect(mustContain).toEqual(expect.arrayContaining([
        expect.stringMatching(/session token/i),
        expect.stringMatching(/sign/i),
        "(?:^|[\\s`(])(?:(?:kb-hub[/\\\\])?kb[/\\\\])?auth\\.md(?=[\\s`),.;:]|$)",
      ]));
      const validParaphrase = "Authentication uses signed session tokens. Tokens have a 24-hour expiration, and refresh tokens are rotated on use. Source: auth.md";
      for (const pattern of mustContain) {
        expect(new RegExp(pattern, "i").test(validParaphrase), `pattern should match valid paraphrase: ${pattern}`).toBe(true);
      }
      const reversedParaphrase = "Authentication uses signed session tokens. Tokens expire after 24 hours. Rotated refresh tokens are used. Source: auth.md";
      for (const pattern of mustContain) {
        expect(new RegExp(pattern, "i").test(reversedParaphrase), `pattern should match reversed paraphrase: ${pattern}`).toBe(true);
      }
      expect(new RegExp(mustContain.at(-1)!, "i").test("Source: kb-hub/kb/auth.md")).toBe(true);
      const citationPattern = mustContain.at(-1)!;
      expect(new RegExp(citationPattern, "i").test("Auth uses signed session tokens.")).toBe(false);
      expect(new RegExp(citationPattern, "i").test("Source: kb/auth.md")).toBe(true);
      expect(new RegExp(citationPattern, "i").test("Source: auth.md")).toBe(true);
      expect(new RegExp(citationPattern, "i").test("Source: concepts/auth.md")).toBe(false);
      expect(mustNotContain).toEqual([
        "\\baccess tokens?\\b",
        "\\b(?:JWT|opaque tokens?|signing algorithms?|key management|token format|validation logic|rotation mechan\\w*|error handling|token scopes?|permissions?|server-side|client-side)\\b",
      ]);
      expect(new RegExp(mustNotContain[0]!, "i").test("Access tokens expire after 24 hours.")).toBe(true);
      expect(new RegExp(mustNotContain[1]!, "i").test("The module lacks signing algorithms and key management.")).toBe(true);
      const judgeAssert = assertions.find((a) => String(a.value).endsWith("judge.ts"));
      expect(judgeAssert?.config?.criteria).toEqual([
        expect.objectContaining({ id: "no-fabrication" }),
      ]);
    });

    it("ask scenarios require sub-agents and forbid background mode where sequencing requires it", async () => {
      for (const file of [
        "ask/answerable.yaml",
        "ask/missing-info.yaml",
        "ask/across-hubs.yaml",
        "ask/llmwiki-compounding.yaml",
      ]) {
        const sc = await loadScenario(file);
        const assertions = sc.tests[0].assert as Array<{ value?: string; config?: Record<string, unknown> }>;
        const tools = assertions.find((a) => String(a.value).endsWith("tools-called.ts"));
        expect(tools?.config?.expect, file).toContainEqual({
          name: "task",
          server: "",
        });
        if (file === "ask/across-hubs.yaml") {
          expect(tools?.config?.forbid ?? [], file).not.toContainEqual(expect.objectContaining({
            name: "task",
            arguments: { mode: "background" },
          }));
        } else {
          expect(tools?.config?.forbid, file).toContainEqual({
            name: "task",
            server: "",
            arguments: { mode: "background" },
          });
        }
      }
    });

    it("ask scenarios require a substantive final user-facing answer", async () => {
      const representativeFinalMessages: Record<string, string> = {
        "ask/missing-info.yaml": "The vacation policy is not documented in this knowledge base.",
        "ask/across-hubs.yaml": "Session tokens are signed in kb-hub / knowledge / kb and git-hub / knowledge / kb.",
        "ask/llmwiki-compounding.yaml": "Attention is the core mechanism used by a Transformer. Filed at syntheses/attention-in-transformer.md.",
      };
      for (const file of [
        "ask/answerable.yaml",
        "ask/missing-info.yaml",
        "ask/across-hubs.yaml",
        "ask/llmwiki-compounding.yaml",
      ]) {
        const sc = await loadScenario(file);
        const assertions = sc.tests[0].assert as Array<{ value?: string; config?: Record<string, unknown> }>;
        const transcript = assertions.find((a) => String(a.value).endsWith("transcript.ts"));
        expect(transcript?.config?.source, file).toBe("final-message");
        const patterns = transcript?.config?.mustContain as string[];
        expect(patterns.length, file).toBeGreaterThan(0);
        const sample = representativeFinalMessages[file];
        if (sample) {
          for (const pattern of patterns) {
            expect(new RegExp(pattern, "i").test(sample), `${file}: ${pattern}`).toBe(true);
          }
        }
      }
    });

    it("across-hubs rejects invented gap categories and causal labels", async () => {
      const sc = await loadScenario("ask/across-hubs.yaml");
      expect(sc.config[0].vars.prompt).toMatch(/preserve each source's\s+evidentiary strength/i);
      expect(sc.config[0].vars.prompt).toMatch(/without turning correlation into causation/i);
      expect(sc.config[0].vars.prompt).toMatch(/separate\s+per-hub fact lists and stop after the facts/i);
      const assertions = sc.tests[0].assert as Array<{ value?: string; config?: Record<string, unknown> }>;
      const transcript = assertions.find((a) => String(a.value).endsWith("transcript.ts"));
      const judge = assertions.find((a) => String(a.value).endsWith("judge.ts"));
      const required = transcript?.config?.mustContain as string[];
      const patterns = transcript?.config?.mustNotContain as string[];
      expect((judge?.config?.criteria as Array<{ id: string }>).map((criterion) => criterion.id)).toEqual([
        "no-fabrication",
      ]);
      expect(new RegExp(required[0]!, "i").test(
        "Here are the authentication and session tokens:\n\n**Token mechanisms:**\n- Tokens are signed",
      )).toBe(true);
      expect(new RegExp(required[1]!, "i").test(
        "## kb-hub\n- Signed session tokens are verified. (source: kb/auth.md)",
      )).toBe(true);
      expect(new RegExp(required[2]!, "i").test(
        "## git-hub\n- Signed session tokens are verified. (source: kb/auth.md)",
      )).toBe(true);
      expect(patterns).toHaveLength(4);
      expect(new RegExp(patterns[0]!, "i").test("Not covered: storage, algorithms, MFA, authorization scopes")).toBe(true);
      expect(new RegExp(patterns[1]!, "i").test("Tokens expire after 24 hours (causal: time -> expiration)")).toBe(true);
      expect(new RegExp(patterns[1]!, "i").test(
        "Tokens are issued at login and verified on each request; these are two separate behaviors that occur (correlation)",
      )).toBe(true);
      expect(new RegExp(patterns[2]!, "i").test(
        "The git-hub module confirms verification but does not document expiration timing",
      )).toBe(true);
      expect(new RegExp(patterns[3]!, "i").test("Citation: concepts/auth.md")).toBe(true);
    });

    it("CSV context requests only selected entries and rejects cited irrelevant paths", async () => {
      const sc = await loadScenario("context/csv-debug.yaml");
      expect(sc.config[0].vars.prompt).toMatch(/rejected files out of the selected working set/i);
      expect(sc.config[0].vars.prompt).toMatch(/relevance\s+from\s+content/i);
      expect(sc.config[0].vars.prompt).toMatch(/exact file paths/i);
      expect(sc.config[0].vars.prompt).toMatch(/bullet items/i);
      expect(sc.config[0].vars.prompt).toMatch(/separate "## Gaps" heading/i);
      const selectionAssert = sc.tests[0].assert.find(
        (a: { value?: string }) => String(a.value).endsWith("working-set-selection.ts"),
      );
      expect(selectionAssert).toBeDefined();
      expect(selectionAssert!.config.forbidden).toEqual(expect.arrayContaining([
        "kb[/\\\\]auth(?:\\.md)?",
        "mem/",
      ]));
      expect(selectionAssert!.config.required).toEqual(expect.arrayContaining([
        "engineering/testing/debugging/SKILL\\.md",
        "tools/csv2json/README\\.md",
      ]));
    });
  });

  it("learn/trivial-fact forbids unnecessary sync after rejection", async () => {
    const scenario = await loadScenario("learn/trivial-fact.yaml");
    const cfg = toolsConfig(scenario);
    expect(cfg.forbid).toContain("sync");
    expect(scenario.config[0].vars.prompt).toMatch(/"learn" skill/i);
    expect(scenario.config[0].vars.prompt).toMatch(/"kb" knowledge module/i);
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
    return assertion?.config as {
      expect: Array<string | { name: string; arguments?: Record<string, unknown> }>;
      forbid?: Array<string | { name: string; arguments?: Record<string, unknown> }>;
      ordered?: boolean;
    } | undefined;
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
    const syncExp = expectations[expectations.length - 1] as { name: string; turn?: number } | string;
    const syncName = typeof syncExp === "string" ? syncExp : syncExp.name;
    expect(syncName).toBe("sync");
    expect(typeof syncExp === "string" ? undefined : syncExp.turn).toBeUndefined();
    expect(sc.config[0].vars.terminal.finalTool).toBeUndefined();
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

  it("initialize/llmwiki.yaml completes the scope and requests the build in the sources reply", async () => {
    const sc = await loadScenario("initialize/llmwiki.yaml");
    const turns = sc.config[0].vars.turns as Array<{ id: string; after: string | string[]; send: string; when?: string }>;
    const sourcesTurn = turns.find((t) => t.id === "sources");
    expect(sourcesTurn, "sources turn must exist").toBeDefined();
    expect(sourcesTurn!.when, "sources must not have a when guard").toBeUndefined();
    expect(sourcesTurn!.after).toBe("tags");
    expect(sourcesTurn!.send).toMatch(/completes the scope decisions/i);
    expect(sourcesTurn!.send).toMatch(/build[\s\S]*empty structure|empty structure[\s\S]*build/i);
    expect(turns.some((turn) => turn.id === "scope-confirmed")).toBe(false);
  });

  it("initialize/llmwiki.yaml completes after the last scope answer without a user sync turn", async () => {
    const sc = await loadScenario("initialize/llmwiki.yaml");
    const turns = sc.config[0].vars.turns as Array<{ id: string; after: string | string[]; send: string; when?: string }>;
    expect(turns.some((turn) => turn.id === "sync-confirmed")).toBe(false);
    expect(sc.config[0].vars.terminal.after).toBe("sources");
    const sourcesTurn = turns.find((turn) => turn.id === "sources");
    expect(sourcesTurn!.send).toMatch(/build\s+the empty structure now/i);
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
    expect(expectations.length).toBeGreaterThanOrEqual(6);

    // 1: ask the wiki before writing
    const askExp = expectations[0] as { name: string; arguments?: Record<string, unknown> };
    expect(askExp.name).toBe("ask");
    expect(askExp.arguments!.container).toBe("wiki-hub");
    expect(askExp.arguments!.module).toBe("wiki");

    // 2: foreground task reads the returned bundle
    const taskExp = expectations[1] as { name: string; server?: string; arguments?: Record<string, unknown> };
    expect(taskExp).toMatchObject({ name: "task", server: "" });

    // 3: module run write
    const writeExp = expectations[2] as { name: string; arguments?: Record<string, unknown> };
    expect(writeExp.name).toBe("run");
    expect(writeExp.arguments!.container).toBe("wiki-hub");
    expect(writeExp.arguments!.module).toBe("wiki");
    expect(writeExp.arguments!.skill).toBe("write");

    // 4: shared okf-writer (no container/module)
    const writerExp = expectations[3] as { name: string; arguments?: Record<string, unknown> };
    expect(writerExp.name).toBe("run");
    expect(writerExp.arguments!.skill).toBe("okf-writer");
    expect(writerExp.arguments).not.toHaveProperty("container");
    expect(writerExp.arguments).not.toHaveProperty("module");

    // 5: inspect
    const inspectExp = expectations[4] as { name: string; arguments?: Record<string, unknown> };
    expect(inspectExp.name).toBe("inspect");

    // 6: sync
    const syncExp = expectations[5] as { name: string; arguments?: Record<string, unknown> };
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
    const transcript = sc.tests[0].assert.find(
      (assertion: { value?: string }) => String(assertion.value).endsWith("transcript.ts"),
    );
    const relationPattern = transcript.config.mustContain[2] as string;
    expect(new RegExp(relationPattern, "i").test(
      "Attention is the fundamental building block of Transformer architecture.",
    )).toBe(true);
  });

  it("run/shared-grilling.yaml routes a concrete plan through the module-less shared skill", async () => {
    const sc = await loadScenario("run/shared-grilling.yaml");
    const cfg = getToolsCalledConfig(sc);
    expect(cfg, "tools-called config must exist").toBeDefined();
    expect(cfg!.expect[0]).toMatchObject({
      name: "run",
      arguments: { skill: "grilling" },
    });
    const args = (cfg!.expect[0] as { arguments: Record<string, unknown> }).arguments;
    expect(args).not.toHaveProperty("container");
    expect(args).not.toHaveProperty("module");
    expect(sc.config[0].vars.prompt).toMatch(/GitHub OAuth/i);
    expect(sc.config[0].vars.prompt).toMatch(/shared "grilling" skill/i);
    expect(sc.config[0].vars.prompt).toMatch(/one decision at a time/i);
    expect(cfg!.forbid).toEqual(expect.arrayContaining(["add_container", "add_module", "sync", "config", "todos"]));
    const assertionValues = sc.tests[0].assert.map((assertion: { value?: string }) => assertion.value);
    expect(assertionValues).toContain("file://assertions/grilling-response.ts");
    expect(assertionValues).toContain("file://assertions/judge.ts");
    expect(getJudgeCriteria(sc)).toEqual([
      expect.objectContaining({ id: "one-decision-topic" }),
    ]);
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

  const REDUNDANT_MECHANICAL_IDS: Record<string, string[]> = {
    "initialize/llmwiki.yaml": ["ran-initialize", "used-grilling", "persisted-via-sync"],
    "write/into-wiki.yaml": ["ran-write", "persisted-via-sync"],
    "lint/wiki-health.yaml": ["ran-lint"],
    "ask/llmwiki-compounding.yaml": ["ran-write", "persisted-via-sync"],
  };

  it("does not spend judge calls re-grading deterministic llmwiki tool assertions", async () => {
    for (const [file, ids] of Object.entries(REDUNDANT_MECHANICAL_IDS)) {
      const sc = await loadScenario(file);
      const criteria = getJudgeCriteria(sc);
      expect(criteria, `${file}: judge criteria must exist`).toBeDefined();
      for (const id of ids) {
        const c = criteria!.find((c) => c.id === id);
        expect(c, `${file}: criterion "${id}" is already covered deterministically`).toBeUndefined();
      }
    }
  });

  it("no judge criterion in the four llmwiki scenarios uses the unsupported advisory key", async () => {
    for (const file of Object.keys(REDUNDANT_MECHANICAL_IDS)) {
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

  it("cold-start chain includes confirmation and a module-purpose answer before wrap-up", async () => {
    const sc = await loadScenario("onboard/cold-start-conversation.yaml");
    const turns = sc.config[0].vars.turns as Array<{ id: string; after: string | string[]; when?: string; send: string }>;
    const ids = turns.map((t) => t.id);
    expect(ids).toEqual(["wake-phrase", "container-choice", "create-confirmed", "module-purpose", "wrap-up"]);
    // Verify the after chain
    expect(turns[0]!.after).toBe("start");
    expect(turns[1]!.after).toBe("wake-phrase");
    expect(turns[2]!.after).toBe("container-choice");
    expect(turns[3]!.after).toBe("create-confirmed");
    expect(turns[4]!.after).toBe("module-purpose");
    expect(turns[1]!.send).toMatch(/I'd like a brand-new folder/i);
    expect(turns[3]!.send).toMatch(/engineering notes and decisions/i);
  });

  it("cold-start setup enforces preview and apply on separate turns", async () => {
    const sc = await loadScenario("onboard/cold-start-conversation.yaml");
    const tools = sc.tests[0].assert.find(
      (assertion: { value?: string }) => String(assertion.value).endsWith("tools-called.ts"),
    );
    expect(tools?.config?.ordered).toBe(true);
    expect(tools?.config?.expect).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "add_container", turn: 3 }),
      expect.objectContaining({ name: "add_container", turn: 4, arguments: { create: true } }),
      expect.objectContaining({ name: "sync", turn: 5, arguments: { container: "my-notes" } }),
    ]));
    expect(tools?.config?.forbid).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "add_container", turn: 3, arguments: { create: true } }),
      expect.objectContaining({ name: "add_module", turn: 3 }),
    ]));
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

  it("llmwiki linear chain ends at the final source-retention answer", async () => {
    const sc = await loadScenario("initialize/llmwiki.yaml");
    const turns = sc.config[0].vars.turns as Array<{ id: string; after: string | string[]; when?: string }>;
    const ids = turns.map((t) => t.id);
    expect(ids).toEqual(["purpose", "goals", "scope", "template", "tags", "sources"]);
    // Verify the linear after chain
    expect(turns[0]!.after).toBe("start");
    expect(turns[1]!.after).toBe("purpose");
    expect(turns[2]!.after).toBe("goals");
    expect(turns[3]!.after).toBe("scope");
    expect(turns[4]!.after).toBe("template");
    expect(turns[5]!.after).toBe("tags");
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
  it("states the fact boundary, permits bare coverage/inference, and rejects unsupported claims", async () => {
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
    expect(text, "must name the fixture-backed root-cause-family link").toMatch(/same root-cause\s+family/i);

    // Must allow only a bare coverage label under this user's no-absent-topics constraint
    expect(text, "must allow a bare coverage label").toMatch(/bare coverage label/i);
    expect(text, "must forbid named absent topics").toMatch(/without named absent topics/i);
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

describe("remember scenarios — deterministic append validation", () => {
  const REMEMBER_FILES = ["remember/test-result.yaml", "remember/incident.yaml"];

  for (const file of REMEMBER_FILES) {
    it(`${file}: uses memory-append without advisory judge calls`, async () => {
      const doc = parseYaml(await readFile(join(SCENARIOS, file), "utf8"));
      const sc = doc[0];
      const asserts: Array<{ type: string; value?: string; config?: Record<string, unknown> }> = sc.tests[0].assert;

      const memAppend = asserts.find(
        (a) => a.type === "javascript" && String(a.value).endsWith("memory-append.ts"),
      );
      expect(memAppend, `${file}: memory-append assertion must exist`).toBeDefined();

      const judgeAssert = asserts.find(
        (a) => a.type === "javascript" && String(a.value).endsWith("judge.ts"),
      );
      expect(judgeAssert, `${file}: deterministic evidence should avoid judge calls`).toBeUndefined();

      const toolsAssert = asserts.find(
        (a) => a.type === "javascript" && String(a.value).endsWith("tools-called.ts"),
      );
      expect(toolsAssert?.config?.ordered, `${file}: routing expectations must be ordered`).toBe(true);
      const expected = toolsAssert?.config?.expect as Array<{ name: string; arguments?: Record<string, unknown> }>;
      expect(expected[0]).toMatchObject({
        name: "run",
        arguments: { container: "kb-hub", module: "mem", skill: "remember" },
      });

      expect(expected.at(-1)).toMatchObject({
        name: "sync",
        arguments: { container: "kb-hub" },
      });
      expect(sc.config[0].vars.terminal).toMatchObject({
        after: "start",
        requiredTools: ["run", "sync"],
        finalTool: "sync",
      });
    });
  }
});

describe("reflect scenario — deterministic proposal validation", () => {
  it("uses the requested memory skill, cites both entries, and does not mutate modules", async () => {
    const doc = parseYaml(await readFile(join(SCENARIOS, "reflect/memory-module.yaml"), "utf8"));
    const sc = doc[0];
    const assertions = sc.tests[0].assert as Array<{ value?: string; config?: Record<string, unknown> }>;
    const toolsAssert = assertions.find((a) => String(a.value).endsWith("tools-called.ts"));
    expect(toolsAssert?.config?.expect).toEqual([
      expect.objectContaining({
        name: "run",
        arguments: { container: "kb-hub", module: "mem", skill: "reflect" },
      }),
    ]);
    expect(toolsAssert?.config?.forbid).toEqual(expect.arrayContaining(["sync", "todos"]));
    const transcriptAssert = assertions.find((a) => String(a.value).endsWith("transcript.ts"));
    expect(transcriptAssert?.config?.source).toBe("final-message");
    expect(transcriptAssert?.config?.mustContain).toEqual(expect.arrayContaining(["2026-01-01", "2026-02-15"]));
    const unchangedModules = assertions
      .filter((a) => String(a.value).endsWith("module-unchanged.ts"))
      .map((a) => a.config?.module);
    expect(unchangedModules).toEqual(["mem", "kb"]);
    expect(assertions.some((a) => String(a.value).endsWith("judge.ts"))).toBe(false);
    expect(sc.config[0].vars.prompt).toMatch(/"reflect" skill/i);
    expect(sc.config[0].vars.prompt).toMatch(/do not apply/i);
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
