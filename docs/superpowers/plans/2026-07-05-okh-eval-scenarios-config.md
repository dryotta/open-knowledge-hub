# OKH Eval: Single Scenarios-Based promptfooconfig.yaml — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 16 standalone per-file promptfoo configs with a single `eval/promptfooconfig.yaml` that pulls every case in via promptfoo's native `scenarios` feature, so `npm run eval` runs one config (concurrently) instead of one process per file.

**Architecture:** One top-level config declares a `{{prompt}}` pass-through prompt, the shared provider once, and a `scenarios: [file://scenarios/**/*.yaml]` glob. Each existing `scenarios/<verb>/<case>.yaml` becomes a one-element scenario list whose `config[0].vars` carries `prompt` + `env` and whose `tests[0].assert` keeps the current assertions. `run-scenarios.ts` collapses to a single promptfoo invocation; the manual harness (`okh-eval.ts`) and `config.test.ts` are updated to the new shape.

**Tech Stack:** promptfoo (scenarios + glob), TypeScript custom provider/assertions loaded via `node --import tsx`, vitest (`vitest.eval.config.ts`), YAML.

---

## Verified facts (do not re-litigate)

- **`file://` in assertions resolves relative to the BASE config dir (`eval/`), NOT the scenario file.** Empirically confirmed: `file://../../assertions/x` from a scenario two levels deep escaped to `D:\work\assertions\x` (ENOENT); `file://assertions/x` loaded correctly. **Therefore every assertion `value` in scenario files must be `file://assertions/<name>.ts`** (drop the `../../`).
- The top-level provider `file://scenarios/shared/provider.ts` and glob `file://scenarios/**/*.yaml` both resolve relative to `eval/` and work. `shared/` holds only `provider.ts` (no `.yaml`), so the glob never picks it up.
- The provider reads `context.vars.env` (`copilotProvider.ts:34-38`); scenario `config[].vars` become the test vars, so `env` + rendered `{{prompt}}` reach it unchanged.
- `npm run eval` = `node --import tsx eval/run-scenarios.ts eval`; `npm run eval:validate` = `... run-scenarios.ts validate`. Keep these signatures.
- Env→count invariants (must still hold): `local-and-git` = 9, `git` = 1, `empty` = 6; total = 16.

## File Structure

- **Create** `eval/promptfooconfig.yaml` — the single default config.
- **Modify** all 16 `eval/scenarios/<verb>/<case>.yaml` — convert to scenario lists (see recipe + table).
- **Modify** `eval/run-scenarios.ts` — run one config instead of looping files.
- **Modify** `eval/okh-eval.ts` — `loadScenarios()` reads the new shape.
- **Modify** `eval-test/config.test.ts` — assert the new shape + the new top-level config.
- **Modify** `eval/README.md` — describe the scenarios model.
- **Unchanged:** `eval/scenarios/shared/provider.ts`, `eval/provider/copilotProvider.ts`, `eval/environments.ts`, `eval/assertions/*.ts`, `eval/judge.ts`, `eval/copilot.ts`, fixtures, and `eval-test/okh-eval.test.ts` (its expectations are preserved by the `loadScenarios` update).

---

## Conversion recipe (applies to every scenario file)

Transform each file from the standalone shape:

```yaml
# <leading comment>
description: <DESC>
providers:
  - file://../shared/provider.ts
prompts:
  - |
    <PROMPT TEXT>
tests:
  - vars:
      env: <ENV>
    assert:
      - <ASSERTS with file://../../assertions/...>
```

into a **one-element scenario list**:

```yaml
# <leading comment>
- description: <DESC>
  config:
    - vars:
        env: <ENV>
        prompt: |
          <PROMPT TEXT>
  tests:
    - assert:
        - <ASSERTS with file://assertions/...>
```

Mechanical rules, applied to every file:
1. Prefix the document with `- ` (it becomes a YAML list of one scenario). Indent everything under it by 2 spaces.
2. **Delete** the `providers:` block (now top-level in `promptfooconfig.yaml`).
3. Move the `prompts[0]` block scalar into `config[0].vars.prompt` (a `|` block).
4. Move `tests[0].vars.env` into `config[0].vars.env`. `tests[0]` keeps **only** `assert:` (no `vars`).
5. In every assertion, rewrite `value: file://../../assertions/<name>.ts` → `value: file://assertions/<name>.ts`. Nothing else in the asserts changes (keep `config`, `criteria`, `check`, `artifacts`, inline `{ ... }` style, ordering).
6. Keep the leading `#` comment and the `description` text verbatim.

`config.test.ts` (Task 1) mechanically enforces rules 1-6 on all 16 files, so it is the correctness gate.

### File table (all 16 — env + assertion files each references, in order)

| file | env | assertion files (all become `file://assertions/…`) |
|------|-----|-----|
| `ask/answerable.yaml` | local-and-git | tools-called, transcript, judge |
| `ask/across-hubs.yaml` | local-and-git | tools-called, judge |
| `ask/missing-info.yaml` | local-and-git | tools-called, judge |
| `context/login-task.yaml` | local-and-git | tools-called, judge |
| `context/csv-debug.yaml` | local-and-git | tools-called, transcript, judge |
| `learn/useful-fact.yaml` | git | tools-called, okf-valid, git-committed, judge |
| `learn/trivial-fact.yaml` | local-and-git | tools-called, module-unchanged, judge |
| `remember/incident.yaml` | local-and-git | tools-called, memory-append, judge |
| `remember/test-result.yaml` | local-and-git | tools-called, memory-append, judge |
| `reflect/memory-module.yaml` | local-and-git | tools-called, judge |
| `onboard/explain.yaml` | empty | judge |
| `onboard/cold-start-phrase.yaml` | empty | tools-called, judge |
| `onboard/custom-name.yaml` | empty | tools-called, wake-phrase-set, judge |
| `onboard/existing-folder.yaml` | empty | tools-called, container-registered, manifest-initialized, judge |
| `onboard/new-hub.yaml` | empty | tools-called, container-registered, manifest-initialized, judge |
| `onboard/github-repo.yaml` | empty | tools-called, container-registered, judge |

### Worked examples (cover every structural variant)

**A. simple judge-only — `onboard/explain.yaml`:**

```yaml
# onboard flow — explain OKH and offer to set up a first hub.
- description: Onboard - explain request - explains OKH and setup
  config:
    - vars:
        env: empty
        prompt: |
          hub, explain what the Open Knowledge Hub is and how it organizes knowledge,
          and tell me how I'd set up my first hub.
  tests:
    - assert:
        - type: javascript
          value: file://assertions/judge.ts
          config:
            criteria:
              - id: explains-containers-modules
                text: The agent explains OKH as containers of typed modules.
              - id: offers-setup-help
                text: The agent offers to help the user set up or add a first hub.
```

**B. tools + transcript + judge — `ask/answerable.yaml`:**

```yaml
# ask flow — answer strictly from a container's knowledge module.
- description: Ask - answerable question - grounded answer, cites source
  config:
    - vars:
        env: local-and-git
        prompt: |
          Use the open-knowledge-hub MCP tools. In container "kb-hub", answer strictly
          from its knowledge module: How does auth work?
  tests:
    - assert:
        - type: javascript
          value: file://assertions/tools-called.ts
          config: { expect: [ask] }
        - type: javascript
          value: file://assertions/transcript.ts
          config: { mustContain: ["token"] }
        - type: javascript
          value: file://assertions/judge.ts
          config:
            criteria:
              - id: grounded-token-auth
                text: The answer reflects token-based auth from the Auth concept (e.g. session tokens, ~24h expiry, or refresh rotation).
              - id: cites-auth
                text: The answer cites the Auth concept or its source path.
              - id: no-fabrication
                text: The answer invents nothing beyond the container's knowledge module.
```

**C. tools + container + manifest + judge-with-checks — `onboard/new-hub.yaml`:**

```yaml
# onboard flow — preview, then create a new local hub with a kb module.
- description: Onboard - new hub - previews, then creates
  config:
    - vars:
        env: empty
        prompt: |
          hub, create a new knowledge hub in a folder called "my-notes" and add a
          knowledge module named "kb". Show me the plan and wait for my confirmation
          before creating anything; when you ask, assume I say yes.
  tests:
    - assert:
        - type: javascript
          value: file://assertions/tools-called.ts
          config: { expect: [add] }
        - type: javascript
          value: file://assertions/container-registered.ts
          config: { name: my-notes, backend: local, module: kb }
        - type: javascript
          value: file://assertions/manifest-initialized.ts
          config: { name: my-notes }
        - type: javascript
          value: file://assertions/judge.ts
          config:
            criteria:
              - id: previewed-before-apply
                text: The agent showed/echoed a plan describing what it would create before creating anything.
              - id: created-hub-and-kb
                text: A container "my-notes" with a "kb" knowledge module was created.
                check: { kind: container, name: my-notes, backend: local, module: kb }
              - id: called-add
                text: The agent used the add tool.
                check: { kind: tool, name: add }
```

**D. judge-with-artifacts — `remember/incident.yaml`:**

```yaml
# remember flow — append a raw, timestamped observation.
- description: Remember - incident - appends raw timestamped entry
  config:
    - vars:
        env: local-and-git
        prompt: |
          Use the open-knowledge-hub MCP tools. Remember this observation in container
          "kb-hub": "The login endpoint returned 500s for ~3 minutes at 14:05 UTC during deploy."
  tests:
    - assert:
        - type: javascript
          value: file://assertions/tools-called.ts
          config: { expect: [remember] }
        - type: javascript
          value: file://assertions/memory-append.ts
          config: { module: mem, baselineFileCount: 2 }
        - type: javascript
          value: file://assertions/judge.ts
          config:
            artifacts: { module: mem }
            criteria:
              - id: recorded-incident
                text: A factual, timestamped memory entry capturing the 500s incident was recorded (see the ON-DISK ARTIFACTS).
```

The remaining 12 files follow the identical recipe; their env + assertions are in the file table above, and their `description`/`prompt`/`criteria`/`check`/`config` bodies are copied verbatim from the current files with only rules 1-6 applied.

---

### Task 1: Rewrite `config.test.ts` to the scenarios shape (RED)

**Files:**
- Modify: `eval-test/config.test.ts`

- [ ] **Step 1: Replace the "scenario configs" describe block and add a top-level-config check**

Replace the entire file body from the `describe("scenario configs", …)` block onward (keep the imports and the `describe("shared provider", …)` block as-is) with:

```ts
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
  it("provides 16 scenario files across the expected verb folders", async () => {
    const files = await scenarioFiles();
    expect(files.length).toBe(16);
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

      // a unique, descriptive sentence — not a one-word dashed id
      expect(typeof sc.description, `${file}: description is a string`).toBe("string");
      expect(sc.description.trim().length).toBeGreaterThan(10);
      expect(sc.description).toContain(" ");
      expect(seenDescriptions.has(sc.description)).toBe(false);
      seenDescriptions.add(sc.description);

      // exactly one config set with a bare-string prompt (no {{prompt}}) and a known env
      expect(Array.isArray(sc.config)).toBe(true);
      expect(sc.config).toHaveLength(1);
      const vars = sc.config[0].vars;
      expect(typeof vars.prompt, `${file}: prompt is a bare string`).toBe("string");
      expect(vars.prompt.trim().length).toBeGreaterThan(0);
      expect(vars.prompt).not.toContain("{{prompt}}");
      expect(Object.keys(environments)).toContain(vars.env);

      // exactly one test: only asserts, no per-test vars/prompt filter
      expect(Array.isArray(sc.tests)).toBe(true);
      expect(sc.tests).toHaveLength(1);
      const test = sc.tests[0];
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
```

- [ ] **Step 2: Run the test to verify it fails (RED)**

Run: `npm run test:eval -- eval-test/config.test.ts`
Expected: FAIL — `promptfooconfig.yaml` does not exist yet and the current scenario files are not YAML lists.

- [ ] **Step 3: Commit the failing test**

```bash
git add eval-test/config.test.ts
git commit -m "test(eval): assert single scenarios-based config shape"
```

---

### Task 2: Create `eval/promptfooconfig.yaml`

**Files:**
- Create: `eval/promptfooconfig.yaml`

- [ ] **Step 1: Write the config**

```yaml
# Single default eval config: one {{prompt}} pass-through, the shared Copilot
# provider, and every case pulled in as a scenario. Run via `npm run eval`.
description: OKH E2E eval (Copilot CLI)
prompts:
  - "{{prompt}}"
providers:
  - file://scenarios/shared/provider.ts
scenarios:
  - file://scenarios/**/*.yaml
```

- [ ] **Step 2: Verify the config half of the test passes**

Run: `npm run test:eval -- eval-test/config.test.ts -t "promptfooconfig.yaml"`
Expected: PASS (the "scenario configs" block still fails until Task 3).

- [ ] **Step 3: Commit**

```bash
git add eval/promptfooconfig.yaml
git commit -m "feat(eval): add single scenarios-based promptfooconfig.yaml"
```

---

### Task 3: Convert all 16 scenario files to scenario lists

**Files (all Modify):** every file in the **File table** above.

- [ ] **Step 1: Convert each file with the recipe (rules 1-6)**

Apply the conversion recipe to all 16 files. Use worked examples A-D as the templates for each structural variant, and the file table for env + assertion set. Preserve each file's leading comment, `description`, prompt text, and all `criteria`/`check`/`config`/`artifacts` bodies verbatim — change only structure (rules 1-4) and assertion paths (rule 5). For `learn/useful-fact.yaml` note the two extra assertions (`okf-valid`, `git-committed`) and the `check: { kind: tool, name: sync }` on its judge criterion — copy them verbatim with the path rewrite.

- [ ] **Step 2: Run the full config test (GREEN)**

Run: `npm run test:eval -- eval-test/config.test.ts`
Expected: PASS — 16 files, each a one-element scenario list, all assertion paths eval-relative and existing.

- [ ] **Step 3: Validate the promptfoo config structurally**

Run: `npm run eval:validate`
Expected: `Configuration is valid.` (single config; the glob loads all 16 scenarios).

- [ ] **Step 4: Commit**

```bash
git add eval/scenarios
git commit -m "refactor(eval): convert scenario files to scenario lists"
```

---

### Task 4: Update `okh-eval.ts` `loadScenarios()` to the new shape

**Files:**
- Modify: `eval/okh-eval.ts` (the `loadScenarios` function, ~lines 64-84)

Note: `eval-test/okh-eval.test.ts` is the test for this task and needs **no changes** — after Task 3 it currently fails (old `loadScenarios` reads `cfg.prompts[0]`), and this task makes it pass again.

- [ ] **Step 1: Confirm the test is currently red**

Run: `npm run test:eval -- eval-test/okh-eval.test.ts`
Expected: FAIL — `loadScenarios` throws / returns wrong data because scenario files no longer have `prompts[0]`.

- [ ] **Step 2: Rewrite `loadScenarios` to read the scenario-list shape**

Replace the `loadScenarios` function body with:

```ts
/** Load every scenario file (a one-element scenario list) and normalize it. */
export async function loadScenarios(): Promise<ScenarioTest[]> {
  const root = join(EVAL_ROOT, "scenarios");
  const out: ScenarioTest[] = [];
  for (const file of await scenarioConfigFiles()) {
    const doc = parseYaml(await readFile(join(root, file), "utf8"));
    const scenarios = Array.isArray(doc) ? doc : [doc];
    for (const sc of scenarios) {
      const vars = sc?.config?.[0]?.vars ?? {};
      const prompt = vars.prompt;
      const test = sc?.tests?.[0];
      if (typeof sc?.description !== "string" || typeof prompt !== "string" || !test) {
        throw new Error(`scenarios/${file}: expected description + config[0].vars.prompt + tests[0]`);
      }
      out.push({
        file,
        description: sc.description,
        env: vars.env,
        prompt,
        assert: test.assert ?? [],
      });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
```

(Keep the existing `import { parse as parseYaml } from "yaml";` and `ScenarioTest` type. If `loadScenarios` previously ended with `return out;` and sorting happened in `scenarioConfigFiles`, keep whatever sort the file already applied — the key point is the new parsing.)

- [ ] **Step 3: Run the manual-harness test (GREEN)**

Run: `npm run test:eval -- eval-test/okh-eval.test.ts`
Expected: PASS — 16 scenarios, per-env counts 9/1/6, each with a non-empty prompt + valid env.

- [ ] **Step 4: Commit**

```bash
git add eval/okh-eval.ts
git commit -m "refactor(eval): read scenario-list shape in manual harness"
```

---

### Task 5: Simplify `run-scenarios.ts` to a single config run

**Files:**
- Modify: `eval/run-scenarios.ts`

- [ ] **Step 1: Replace the file contents**

```ts
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * Runs the single default eval config (`eval/promptfooconfig.yaml`) in ONE
 * promptfoo process. The config pulls every case in via `scenarios:` (a
 * `file://scenarios/**\/*.yaml` glob) with a single `{{prompt}}` pass-through,
 * so promptfoo runs them concurrently with no prompt×test cross-product.
 *
 *   npm run eval          → `promptfoo eval -c eval/promptfooconfig.yaml --no-cache`
 *   npm run eval:validate → `promptfoo validate -c eval/promptfooconfig.yaml`
 *
 * Invoked through `node --import tsx` so the TypeScript provider/assertions
 * load with NodeNext `.js` import specifiers.
 */
const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(EVAL_ROOT, "..");
const CONFIG = join(EVAL_ROOT, "promptfooconfig.yaml");
const PROMPTFOO = resolve(REPO_ROOT, "node_modules", "promptfoo", "dist", "src", "entrypoint.js");

function run(mode: "eval" | "validate"): Promise<number> {
  const args = ["--import", "tsx", PROMPTFOO, mode, "-c", CONFIG];
  if (mode === "eval") args.push("--no-cache");
  return new Promise((res) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", cwd: REPO_ROOT });
    child.on("close", (code) => res(code ?? 1));
    child.on("error", () => res(1));
  });
}

const mode: "eval" | "validate" = process.argv[2] === "validate" ? "validate" : "eval";
run(mode)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
```

(Remove the now-unused `readdir` / `relative` imports and the `configFiles` walk — they are replaced entirely by the block above.)

- [ ] **Step 2: Type-check the eval sources**

Run: `npm run typecheck:eval`
Expected: exit 0, no errors.

- [ ] **Step 3: Re-validate through the npm script**

Run: `npm run eval:validate`
Expected: `Configuration is valid.` (now via the simplified single-config runner).

- [ ] **Step 4: Commit**

```bash
git add eval/run-scenarios.ts
git commit -m "refactor(eval): run single scenarios config instead of per-file loop"
```

---

### Task 6: Update `eval/README.md`

**Files:**
- Modify: `eval/README.md`

- [ ] **Step 1: Update the "How it works" pipeline snippet**

Replace the first line of the fenced pipeline (currently
`promptfoo (eval/scenarios/<verb>/<case>.yaml — one complete config per prompt)`) with:

```
promptfoo (eval/promptfooconfig.yaml — one {{prompt}} pass-through + scenarios: [file://scenarios/**/*.yaml])
```

- [ ] **Step 2: Rewrite the "How test cases work" section**

Replace that section's body with:

```markdown
## How test cases work

`eval/promptfooconfig.yaml` is the single default config. It declares one pass-through
prompt, the shared provider once, and a glob of every scenario file:

​```yaml
prompts:
  - "{{prompt}}"
providers:
  - file://scenarios/shared/provider.ts
scenarios:
  - file://scenarios/**/*.yaml
​```

Each `scenarios/<verb>/<case>.yaml` is a **one-element scenario list**: its `config[0].vars`
supplies the case's `prompt` (rendered into `{{prompt}}`) and `env`, and its `tests[0].assert`
holds the case's assertions. One prompt template × N scenarios means no prompt×test
cross-product — promptfoo runs the scenarios concurrently (default 4 workers) in a single run,
so all cases land in **one** eval record you can browse in `npm run eval:view`.

​```yaml
# scenarios/ask/answerable.yaml — one scenario
- description: Ask - answerable question - grounded answer, cites source
  config:
    - vars:
        env: local-and-git
        prompt: |
          Use the open-knowledge-hub MCP tools. In container "kb-hub", answer strictly
          from its knowledge module: How does auth work?
  tests:
    - assert:
        - { type: javascript, value: file://assertions/tools-called.ts, config: { expect: [ask] } }
        - { type: javascript, value: file://assertions/transcript.ts, config: { mustContain: ["token"] } }
        - type: javascript
          value: file://assertions/judge.ts
          config:
            criteria:
              - id: grounded-token-auth
                text: The answer reflects token-based auth from the Auth concept.
​```

- **Assertion `file://` paths are relative to `eval/`** (the config dir) — `file://assertions/…`,
  not `../../assertions/…`. promptfoo resolves nested `file://` refs against the base config.
- **`description`** names the case (row) in the viewer.
- **`config[0].vars.env`** names the environment to provision (see below).
```

- [ ] **Step 3: Update the "Running automatically" note + key-files table**

- In the key-files table, change the `run-scenarios.ts` row to:
  `| `run-scenarios.ts` | runs `promptfoo eval`/`validate` once on `promptfooconfig.yaml` (single process, concurrent scenarios) |`
  and add a row: `| `promptfooconfig.yaml` | the single default config: `{{prompt}}` pass-through + shared provider + `scenarios:` glob |`.
- Replace the "One config at a time" blockquote under **Running automatically** with:

```markdown
> **One config, concurrent scenarios.** `npm run eval` / `eval:validate` run a **single**
> `promptfoo` process on `eval/promptfooconfig.yaml` (via `run-scenarios.ts`), which globs
> every `scenarios/**/*.yaml` scenario and runs them with promptfoo's default concurrency.
> All cases share one eval record — pick a row in `npm run eval:view`. Both invoke promptfoo
> through `node --import tsx` so the TypeScript provider keeps NodeNext `.js` import specifiers;
> validation prints `Configuration is valid.`
```

- Update the single-scenario hint line to: `# a single scenario: filter by description, e.g. promptfoo eval -c eval/promptfooconfig.yaml --filter-pattern "Ask - answerable"`.

- [ ] **Step 4: Commit**

```bash
git add eval/README.md
git commit -m "docs(eval): document single scenarios-based config"
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Eval type-check + unit tests**

Run: `npm run typecheck:eval` then `npm run test:eval`
Expected: typecheck exit 0; all eval unit tests pass (config: 16 scenario lists + promptfooconfig; okh-eval: 16 scenarios, 9/1/6 per env).

- [ ] **Step 2: Structural validation**

Run: `npm run eval:validate`
Expected: `Configuration is valid.`

- [ ] **Step 3: Core build + tests (no regressions)**

Run: `npm run build` then `npm test`
Expected: build exit 0; core suite passes (unchanged, but the harness runs the built server).

- [ ] **Step 4: Full live e2e eval (larger-change completion criteria)**

Prereq: `npm run build` (done in Step 3) and `copilot` authenticated (Linux/CI: set `GH_TOKEN`).
Run: `npm run eval`
Expected: one eval run with **16** scenario rows; the runner exits 0 when all pass. Open `npm run eval:view` to confirm all 16 cases appear as rows in a single eval record. If any scenario fails on judged criteria (non-deterministic), re-run that case via `--filter-pattern "<description>"` before concluding.

- [ ] **Step 5: Final commit (if any docs/tweaks emerged during verification)**

```bash
git add -A
git commit -m "chore(eval): finalize scenarios-config migration"
```

---

## Self-review checklist (author)

- **Spec coverage:** promptfooconfig.yaml (Task 2), scenario conversion + eval-relative paths (Task 3), run-scenarios single-config (Task 5), okh-eval loadScenarios (Task 4), config.test rewrite (Task 1), okh-eval.test unchanged (Task 4 note), README (Task 6), verification incl. live eval (Task 7). ✅
- **file:// resolution:** resolved empirically → `file://assertions/…` (eval-relative). Baked into recipe rule 5, examples, config.test assertion. ✅
- **Type/name consistency:** `loadScenarios`, `ScenarioTest{file,description,env,prompt,assert}`, `EXPECTED_COUNTS`, `scenarioFiles` used consistently across tasks. ✅
- **Invariants:** env counts 9/1/6, total 16 asserted in both config.test and okh-eval.test. ✅
