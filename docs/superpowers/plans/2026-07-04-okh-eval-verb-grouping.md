# OKH eval: verb-grouped scenarios + verb metadata — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the 16 flat eval scenarios under 6 verb directories and add a per-test `verb` metadata field so the promptfoo combined results grid is filterable by verb, without splitting the single dataset.

**Architecture:** Move `eval/scenarios/<verb>-<case>/` → `eval/scenarios/<verb>/<case>/`. Keep the scenario id `<verb>-<case>` stable everywhere (var, prompt label, `prompts:` filter, description, run-state); the harness reconstructs the id from the two-level path. Add `metadata: { verb }` to each test (part of `config.tests`, so still one dataset). Update the tests glob, the 16 explicit prompt paths, the harness discovery, the config test, and the manual-testing doc.

**Tech Stack:** promptfoo (v0.120.x), TypeScript/tsx, vitest, YAML, PowerShell (Windows).

**Spec:** `docs/superpowers/specs/2026-07-04-okh-eval-verb-grouping-design.md`

---

## Scenario → verb/case mapping (authoritative, 16 rows)

| current folder (`scenarios/<id>`) | new folder (`scenarios/<verb>/<case>`) | id (unchanged) | verb |
|---|---|---|---|
| `onboard-create-local` | `onboard/create-local` | `onboard-create-local` | onboard |
| `onboard-add-existing-folder` | `onboard/add-existing-folder` | `onboard-add-existing-folder` | onboard |
| `onboard-add-github` | `onboard/add-github` | `onboard-add-github` | onboard |
| `onboard-explains` | `onboard/explains` | `onboard-explains` | onboard |
| `onboard-phrase` | `onboard/phrase` | `onboard-phrase` | onboard |
| `onboard-wake-phrase` | `onboard/wake-phrase` | `onboard-wake-phrase` | onboard |
| `ask-grounded` | `ask/grounded` | `ask-grounded` | ask |
| `ask-declines-when-absent` | `ask/declines-when-absent` | `ask-declines-when-absent` | ask |
| `ask-multi-container` | `ask/multi-container` | `ask-multi-container` | ask |
| `context-assembly` | `context/assembly` | `context-assembly` | context |
| `context-includes-skills-tools` | `context/includes-skills-tools` | `context-includes-skills-tools` | context |
| `remember-records` | `remember/records` | `remember-records` | remember |
| `remember-no-conclusions` | `remember/no-conclusions` | `remember-no-conclusions` | remember |
| `reflect-insights` | `reflect/insights` | `reflect-insights` | reflect |
| `learn-integrates` | `learn/integrates` | `learn-integrates` | learn |
| `learn-rejects-trivial` | `learn/rejects-trivial` | `learn-rejects-trivial` | learn |

**id reconstruction rule:** `id = "<verb>-<case>"` where `verb` = parent dir, `case` = leaf dir. Case names never contain the verb prefix, so this is unambiguous.

---

## File structure

- **Move (16):** each `eval/scenarios/<id>/{test.yaml,prompt.md}` → `eval/scenarios/<verb>/<case>/{test.yaml,prompt.md}`.
- **Modify:**
  - `eval/scenarios/<verb>/<case>/test.yaml` (16) — add `metadata: { verb: <verb> }`.
  - `eval/promptfooconfig.yaml` — tests glob → `scenarios/*/*/test.yaml`; 16 prompt `id` paths → `scenarios/<verb>/<case>/prompt.md` (labels unchanged).
  - `eval/okh-eval.ts` — `listScenarios`/`loadScenario` walk two levels (new `scenarioDirs()` helper).
  - `eval-test/config.test.ts` — discover nested dirs; assert `metadata.verb`; keep the 16-id coverage list (ids unchanged).
  - `eval/MANUAL-TESTING.md` — scenario prompt path reference.
- **Unchanged:** `eval-test/okh-eval.test.ts` (ids stable), the provider, assertions, judge, fixtures, `provision.ts`, `run-state.ts`.

---

### Task 1: Reorganize scenario folders into verb directories

**Files:** moves only (no content change).

- [ ] **Step 1: Create the 6 verb directories and move all 16 scenario folders**

Run (PowerShell, from repo root `D:\work\open-knowledge-hub`):

```powershell
cd 'D:\work\open-knowledge-hub\eval\scenarios'
$map = @{
  'onboard-create-local'          = 'onboard/create-local'
  'onboard-add-existing-folder'   = 'onboard/add-existing-folder'
  'onboard-add-github'            = 'onboard/add-github'
  'onboard-explains'              = 'onboard/explains'
  'onboard-phrase'                = 'onboard/phrase'
  'onboard-wake-phrase'           = 'onboard/wake-phrase'
  'ask-grounded'                  = 'ask/grounded'
  'ask-declines-when-absent'      = 'ask/declines-when-absent'
  'ask-multi-container'           = 'ask/multi-container'
  'context-assembly'              = 'context/assembly'
  'context-includes-skills-tools' = 'context/includes-skills-tools'
  'remember-records'              = 'remember/records'
  'remember-no-conclusions'       = 'remember/no-conclusions'
  'reflect-insights'              = 'reflect/insights'
  'learn-integrates'              = 'learn/integrates'
  'learn-rejects-trivial'         = 'learn/rejects-trivial'
}
foreach ($src in $map.Keys) {
  $dst = $map[$src] -replace '/', '\'
  $verb = ($map[$src] -split '/')[0]
  New-Item -ItemType Directory -Force $verb | Out-Null
  Move-Item -Path $src -Destination $dst
}
```

- [ ] **Step 2: Verify the new two-level layout (16 leaves under 6 verbs)**

Run:

```powershell
cd 'D:\work\open-knowledge-hub'
(Get-ChildItem eval\scenarios -Directory).Name -join ', '
(Get-ChildItem eval\scenarios -Directory -Recurse -Depth 1 | Where-Object { Test-Path (Join-Path $_.FullName 'test.yaml') }).Count
```

Expected: first line = `ask, context, learn, onboard, reflect, remember`; second line = `16`.

- [ ] **Step 3: Commit**

```powershell
cd 'D:\work\open-knowledge-hub'
git add -A eval/scenarios
git commit -m "refactor(eval): group scenarios under verb directories

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Add `verb` metadata to every scenario test.yaml

**Files:** Modify all 16 `eval/scenarios/<verb>/<case>/test.yaml`.

Each test.yaml currently looks like:

```yaml
- description: onboard-create-local
  prompts:
    - onboard-create-local
  vars:
    ...
```

Insert a `metadata` block between `prompts:` and `vars:` so it becomes:

```yaml
- description: onboard-create-local
  prompts:
    - onboard-create-local
  metadata:
    verb: onboard
  vars:
    ...
```

- [ ] **Step 1: Add `metadata: { verb }` to each test.yaml**

Apply the insertion to all 16 files, using the `verb` value from the mapping table above. The `verb` value per file:
- `onboard/*` → `verb: onboard` (6 files)
- `ask/*` → `verb: ask` (3 files)
- `context/*` → `verb: context` (2 files)
- `remember/*` → `verb: remember` (2 files)
- `reflect/insights` → `verb: reflect` (1 file)
- `learn/*` → `verb: learn` (2 files)

For each file, insert (matching the file's own `description`/`prompts` id):

```yaml
  metadata:
    verb: <verb>
```

immediately after the two-line `prompts:` block and before `vars:`.

- [ ] **Step 2: Verify all 16 have exactly one verb metadata line, with correct values**

Run:

```powershell
cd 'D:\work\open-knowledge-hub'
Get-ChildItem eval\scenarios -Recurse -Filter test.yaml | ForEach-Object {
  $verb = $_.Directory.Parent.Name
  $line = (Select-String -Path $_.FullName -Pattern '^\s+verb:\s*(\S+)').Matches.Groups[1].Value
  "{0,-34} folder-verb={1,-9} meta-verb={2}" -f $_.Directory.Name, $verb, $line
}
```

Expected: 16 rows; for every row `folder-verb` equals `meta-verb`.

- [ ] **Step 3: Commit**

```powershell
cd 'D:\work\open-knowledge-hub'
git add eval/scenarios
git commit -m "feat(eval): tag each scenario with verb metadata for View Results filtering

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Update promptfooconfig.yaml (tests glob + prompt paths)

**Files:** Modify `eval/promptfooconfig.yaml`.

- [ ] **Step 1: Replace the prompts block and tests glob**

Replace the entire `prompts:` list and the `tests:` line with:

```yaml
prompts:
  # One named prompt per scenario, co-located with its test.yaml under scenarios/<verb>/<case>/.
  # Each test filters to its own prompt via `prompts: [<verb>-<case>]`, so the Prompts view shows
  # real content (not a `{{prompt}}` pass-through) and there is no prompt×test cross-product.
  - { id: file://scenarios/ask/declines-when-absent/prompt.md, label: ask-declines-when-absent }
  - { id: file://scenarios/ask/grounded/prompt.md, label: ask-grounded }
  - { id: file://scenarios/ask/multi-container/prompt.md, label: ask-multi-container }
  - { id: file://scenarios/context/assembly/prompt.md, label: context-assembly }
  - { id: file://scenarios/context/includes-skills-tools/prompt.md, label: context-includes-skills-tools }
  - { id: file://scenarios/learn/integrates/prompt.md, label: learn-integrates }
  - { id: file://scenarios/learn/rejects-trivial/prompt.md, label: learn-rejects-trivial }
  - { id: file://scenarios/onboard/add-existing-folder/prompt.md, label: onboard-add-existing-folder }
  - { id: file://scenarios/onboard/add-github/prompt.md, label: onboard-add-github }
  - { id: file://scenarios/onboard/create-local/prompt.md, label: onboard-create-local }
  - { id: file://scenarios/onboard/explains/prompt.md, label: onboard-explains }
  - { id: file://scenarios/onboard/phrase/prompt.md, label: onboard-phrase }
  - { id: file://scenarios/onboard/wake-phrase/prompt.md, label: onboard-wake-phrase }
  - { id: file://scenarios/reflect/insights/prompt.md, label: reflect-insights }
  - { id: file://scenarios/remember/no-conclusions/prompt.md, label: remember-no-conclusions }
  - { id: file://scenarios/remember/records/prompt.md, label: remember-records }
tests: file://scenarios/*/*/test.yaml
```

Leave the `description:`, `providers:` block, and the header comment lines above `prompts:` unchanged.

- [ ] **Step 2: Validate the config (checks glob + prompt-reference integrity)**

Run:

```powershell
cd 'D:\work\open-knowledge-hub'; npm run eval:validate
```

Expected: output ends with `Configuration is valid.` (promptfoo errors here if any `prompts: [<id>]` filter has no matching prompt label, or the glob matches no tests).

- [ ] **Step 3: Commit**

```powershell
cd 'D:\work\open-knowledge-hub'
git add eval/promptfooconfig.yaml
git commit -m "refactor(eval): point config at verb-nested scenario paths

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Update the manual harness to discover scenarios two levels deep

**Files:** Modify `eval/okh-eval.ts`.

- [ ] **Step 1: Replace `listScenarios` and `loadScenario` with two-level discovery**

Find the current block:

```ts
export async function listScenarios(): Promise<string[]> {
  const dirs = await readdir(join(EVAL_ROOT, "scenarios"), { withFileTypes: true });
  return dirs.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export async function loadScenario(name: string): Promise<ScenarioTest> {
  const dir = join(EVAL_ROOT, "scenarios", name);
  const raw = await readFile(join(dir, "test.yaml"), "utf8");
  const list = parseYaml(raw);
  if (!Array.isArray(list) || list.length === 0) throw new Error(`scenario "${name}": expected a non-empty test list`);
  const test = list[0] as ScenarioTest;
  test.prompt = await readFile(join(dir, "prompt.md"), "utf8");
  return test;
}
```

Replace it with:

```ts
/** Map scenario id (`<verb>-<case>`) -> leaf dir, discovered from scenarios/<verb>/<case>/. */
async function scenarioDirs(): Promise<Map<string, string>> {
  const root = join(EVAL_ROOT, "scenarios");
  const map = new Map<string, string>();
  for (const verb of await readdir(root, { withFileTypes: true })) {
    if (!verb.isDirectory()) continue;
    for (const leaf of await readdir(join(root, verb.name), { withFileTypes: true })) {
      if (!leaf.isDirectory()) continue;
      map.set(`${verb.name}-${leaf.name}`, join(root, verb.name, leaf.name));
    }
  }
  return map;
}

export async function listScenarios(): Promise<string[]> {
  return [...(await scenarioDirs()).keys()].sort();
}

export async function loadScenario(name: string): Promise<ScenarioTest> {
  const dir = (await scenarioDirs()).get(name);
  if (!dir) throw new Error(`scenario "${name}": not found under eval/scenarios/<verb>/<case>/`);
  const raw = await readFile(join(dir, "test.yaml"), "utf8");
  const list = parseYaml(raw);
  if (!Array.isArray(list) || list.length === 0) throw new Error(`scenario "${name}": expected a non-empty test list`);
  const test = list[0] as ScenarioTest;
  test.prompt = await readFile(join(dir, "prompt.md"), "utf8");
  return test;
}
```

(`readdir`, `readFile`, `join`, `parseYaml`, `EVAL_ROOT`, and `ScenarioTest` are already imported/declared in this file — no new imports needed.)

- [ ] **Step 2: Typecheck the eval code**

Run:

```powershell
cd 'D:\work\open-knowledge-hub'; npm run typecheck:eval
```

Expected: exit 0, no output errors.

- [ ] **Step 3: Run the harness tests (ids are unchanged, so these must still pass)**

Run:

```powershell
cd 'D:\work\open-knowledge-hub'; npx vitest run --config vitest.eval.config.ts eval-test/okh-eval.test.ts
```

Expected: all tests pass (including "lists all 16 scenarios" and `loadScenario("ask-grounded")`).

- [ ] **Step 4: Commit**

```powershell
cd 'D:\work\open-knowledge-hub'
git add eval/okh-eval.ts
git commit -m "refactor(eval): discover scenarios under verb dirs, id stays <verb>-<case>

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Update config.test.ts for nested discovery + verb metadata

**Files:** Modify `eval-test/config.test.ts`.

- [ ] **Step 1: Add a nested-discovery helper**

After the existing `const exists = ...` line near the top of the file, add:

```ts
async function discoverScenarios() {
  const root = join(EVAL, "scenarios");
  const out: { id: string; verb: string; relPrompt: string; dir: string }[] = [];
  for (const verb of (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory())) {
    for (const leaf of (await readdir(join(root, verb.name), { withFileTypes: true })).filter((e) => e.isDirectory())) {
      out.push({
        id: `${verb.name}-${leaf.name}`,
        verb: verb.name,
        relPrompt: `file://scenarios/${verb.name}/${leaf.name}/prompt.md`,
        dir: join(root, verb.name, leaf.name),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
```

- [ ] **Step 2: Replace the "defines one named prompt per scenario" test body**

Replace the current test that starts `it("defines one named prompt per scenario, ...` with:

```ts
  it("defines one named prompt per scenario, each pointing at an existing prompt.md", async () => {
    const cfg = parseYaml(await readFile(join(EVAL, "promptfooconfig.yaml"), "utf8"));
    const scenarios = await discoverScenarios();
    expect(Array.isArray(cfg.prompts)).toBe(true);
    const byLabel = new Map<string, string>(
      cfg.prompts.map((p: { id: string; label: string }) => [p.label, p.id]),
    );
    expect([...byLabel.keys()].sort()).toEqual(scenarios.map((s) => s.id));
    for (const s of scenarios) {
      expect(byLabel.get(s.id)).toBe(s.relPrompt);
      expect(await exists(join(s.dir, "prompt.md"))).toBe(true);
    }
    expect(String(cfg.tests)).toContain("scenarios/*/*/test.yaml");
  });
```

- [ ] **Step 3: Replace the "scenarios" describe block body**

Replace the whole `describe("scenarios", ...)` block with:

```ts
describe("scenarios", () => {
  it("all 16 scenarios parse, reference existing fixtures + assertion files, have judge criteria + verb metadata", async () => {
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
      expect(test.prompts).toEqual([s.id]);
      expect(test.metadata?.verb).toBe(s.verb);
      expect((await readFile(join(s.dir, "prompt.md"), "utf8")).trim().length).toBeGreaterThan(0);
      expect(await exists(join(EVAL, String(test.vars.fixture)))).toBe(true);
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
```

- [ ] **Step 4: Run the config tests**

Run:

```powershell
cd 'D:\work\open-knowledge-hub'; npx vitest run --config vitest.eval.config.ts eval-test/config.test.ts
```

Expected: all tests pass (prompt mapping, tests glob, 16-scenario coverage, `metadata.verb` matches folder).

- [ ] **Step 5: Commit**

```powershell
cd 'D:\work\open-knowledge-hub'
git add eval-test/config.test.ts
git commit -m "test(eval): verify verb-nested layout + verb metadata

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Update MANUAL-TESTING.md path reference

**Files:** Modify `eval/MANUAL-TESTING.md`.

- [ ] **Step 1: Update the scenario prompt path reference**

Replace:

```markdown
- Paste the scenario prompt (from `eval\scenarios\<name>\prompt.md`).
```

with:

```markdown
- Paste the scenario prompt (from `eval\scenarios\<verb>\<case>\prompt.md`).
```

- [ ] **Step 2: Commit**

```powershell
cd 'D:\work\open-knowledge-hub'
git add eval/MANUAL-TESTING.md
git commit -m "docs(eval): update manual scenario path to verb/case layout

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Full offline verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full eval verification trio**

Run:

```powershell
cd 'D:\work\open-knowledge-hub'; npm run eval:validate; npm run typecheck:eval; npm run test:eval
```

Expected: `Configuration is valid.`; typecheck exit 0; `test:eval` all tests pass (config + harness).

- [ ] **Step 2: Offline echo run over the new layout (no premium requests, no auth)**

This confirms the `*/*` glob resolves all 16, produces one dataset with 16 test cases, and that `metadata.verb` is carried on each result. Run:

```powershell
$src = 'D:\work\open-knowledge-hub\eval'; $dst = "$env:TEMP\echo-eval2"
Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$dst\scenarios" | Out-Null
Get-ChildItem "$src\scenarios" -Directory | ForEach-Object {
  $verb = $_.Name
  Get-ChildItem $_.FullName -Directory | ForEach-Object {
    $leaf = "$dst\scenarios\$verb\$($_.Name)"
    New-Item -ItemType Directory -Force $leaf | Out-Null
    Copy-Item "$($_.FullName)\prompt.md" "$leaf\prompt.md"
    $lines = Get-Content "$($_.FullName)\test.yaml"
    $idx = ($lines | Select-String -Pattern '^  assert:').LineNumber
    if ($idx) { $lines = $lines[0..($idx-2)] }
    Set-Content "$leaf\test.yaml" $lines
  }
}
$cfgLines = Get-Content "$src\promptfooconfig.yaml"
$promptsStart = ($cfgLines | Select-String -Pattern '^prompts:').LineNumber - 1
$rest = $cfgLines[$promptsStart..($cfgLines.Count-1)] -join "`n"
Set-Content "$dst\promptfooconfig.yaml" ("description: echo2`nproviders:`n  - id: echo`n" + $rest)
cd 'D:\work\open-knowledge-hub'
node ./node_modules/promptfoo/dist/src/entrypoint.js eval -c "$dst\promptfooconfig.yaml" -o "$dst\out.json" --no-cache 2>&1 | Select-Object -Last 4
$j = Get-Content "$dst\out.json" -Raw | ConvertFrom-Json
"results=$($j.results.results.Count) (expect 16)"
"distinct verbs: " + (($j.results.results | ForEach-Object { $_.testCase.metadata.verb } | Sort-Object -Unique) -join ', ')
```

Expected: `results=16`; `distinct verbs: ask, context, learn, onboard, reflect, remember`.

- [ ] **Step 3: Clean up the echo temp dir**

```powershell
Remove-Item -Recurse -Force "$env:TEMP\echo-eval2" -ErrorAction SilentlyContinue
```

---

### Task 8: Full live eval + viewer verification (larger-change completion criteria)

**Files:** none (produces a fresh eval in the promptfoo DB).

- [ ] **Step 1: Clear old eval history and rebuild**

Run:

```powershell
cd 'D:\work\open-knowledge-hub'
"y" | node ./node_modules/promptfoo/dist/src/entrypoint.js delete eval all
npm run build
```

Expected: `All evaluations have been deleted.`; build exit 0.

- [ ] **Step 2: Run the full live eval**

Run (long-running; needs authenticated Copilot CLI):

```powershell
cd 'D:\work\open-knowledge-hub'; npm run eval
```

Expected: `Results: ✓ 16 passed, 0 failed, 0 errors (100%)`.

- [ ] **Step 3: Verify verb metadata is filterable in the viewer**

Start the viewer and confirm the metadata keys endpoint exposes `verb`:

```powershell
cd 'D:\work\open-knowledge-hub'
$env:BROWSER="none"; Start-Process -NoNewWindow node -ArgumentList './node_modules/promptfoo/dist/src/entrypoint.js','view','-y','-p','15500'
Start-Sleep 6
$latest = (Invoke-RestMethod "http://localhost:15500/api/results").data[0].evalId
(Invoke-RestMethod "http://localhost:15500/api/eval/$latest/metadata-keys").keys -join ', '
```

Expected: the returned keys include `verb`. In the browser (`http://localhost:15500`), View Results → Add filter → Metadata → `verb` `equals` `onboard` filters the grid to the 6 onboard rows.

- [ ] **Step 4: Final status (no commit — verification only)**

Confirm `git status` is clean for `eval/` (all implementation already committed in Tasks 1–6).

---

## Self-review notes

- **Spec coverage:** layout (T1), stable ids (T1/T4), verb metadata (T2), config glob+paths (T3), harness (T4), config test (T5), docs (T6), verification incl. live eval (T7/T8). All spec sections mapped.
- **Type consistency:** helper names `scenarioDirs()` (harness) and `discoverScenarios()` (test) are distinct by design (different return shapes, different files). id rule `<verb>-<case>` used identically in both.
- **No placeholders:** every code/command step is concrete; the 16 verb values in T2 are enumerated by the mapping table.
