# Reliable OKH E2E Judge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flaky single-shot 0–1 LLM judge with a self-consistent, binary-per-criterion judge (k judge runs on one agent transcript, per-criterion majority vote) that cross-checks any objectively-verifiable criterion against deterministic ground truth and flags disagreements.

**Architecture:** The judge stays a Copilot-CLI call (no external key). `eval/judge.ts` gains `runJudgeCriteria` (runs the judge `k` times, parses a strict JSON array of `{id, verdict, evidence}` per run, majority-votes each criterion). A new `eval/assertions/checks.ts` holds shared deterministic evaluators (`tool`/`container`/`manifest`/`wake-phrase`/`transcript-*`) reused by both the standalone assertions and the judge's cross-check. `eval/assertions/judge.ts` orchestrates: judge → per-criterion majority → cross-check against `checks.ts` → gate. All 15 scenarios migrate from `rubric`/`threshold` to `criteria`.

**Tech Stack:** TypeScript NodeNext ESM (relative imports use `.js`), Vitest eval suite (`vitest.eval.config.ts`), promptfoo, GitHub Copilot CLI judge. Injectable `CopilotRunner` keeps all unit tests offline.

Design spec: `docs/superpowers/specs/2026-07-03-okh-eval-judge-reliability-design.md`

Verification commands used throughout:
- Eval typecheck: `npm run typecheck:eval`
- Eval unit tests: `npm run test:eval`
- Single eval file: `npx vitest run --config vitest.eval.config.ts eval-test/<file>.test.ts`
- Structure: `npm run eval:validate`
- Core suite (must stay green — this work does not touch `src/`): `npm test`

Commit after each task with the message shown + trailer:
`Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`

---

## File Structure

- **Modify** `eval/judge.ts` — add `extractJsonArray`; add `Criterion`, `CriterionResult` types + `runJudgeCriteria` (k-way self-consistency + per-criterion majority); factor a private `judgeOnce`; remove the now-unused single-shot `runJudge`/`gradePrompt` at the end (Task 4).
- **Create** `eval/assertions/checks.ts` — `Check` union, `CheckContext`, `evaluateCheck`, and shared `checkContainer`/`checkManifest`/`checkWakePhrase` helpers.
- **Modify** `eval/assertions/container-registered.ts`, `manifest-initialized.ts`, `wake-phrase-set.ts` — delegate to `checks.ts` (external signature unchanged).
- **Modify** `eval/assertions/judge.ts` — consume `criteria`, run `runJudgeCriteria`, cross-check via `checks.ts`, gate + structured reason. Keep `buildArtifactsSection` unchanged.
- **Modify** `eval-test/judge.test.ts` — keep `extractJson`/`buildArtifactsSection` tests; add `extractJsonArray` + `runJudgeCriteria` tests; drop `runJudge` tests.
- **Create** `eval-test/checks.test.ts` — unit-test each `evaluateCheck` kind.
- **Create** `eval-test/judge-assertion.test.ts` — unit-test the `judge.ts` assertion (majority, cross-check disagreement, unreliable, advisory, borderline) with a fake runner + fake metadata.
- **Modify** all 15 `eval/scenarios/*/test.yaml` — migrate the `judge` assertion to `criteria`.
- **Modify** `eval/README.md` — document the criteria rubric, `k`/`OKH_JUDGE_K`, self-consistency + cross-check.

---

## Task 1: `extractJsonArray` in `eval/judge.ts`

**Files:**
- Modify: `eval/judge.ts`
- Test: `eval-test/judge.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `eval-test/judge.test.ts` (and add `extractJsonArray` to the existing import from `../eval/judge.js`):

```ts
describe("extractJsonArray", () => {
  it("extracts the last balanced JSON array amid prose/fences", () => {
    const a = extractJsonArray('thinking [1] then [{"id":"x","verdict":"PASS"}]');
    expect(a).toEqual([{ id: "x", verdict: "PASS" }]);
  });
  it("handles brackets inside strings", () => {
    const a = extractJsonArray('[{"id":"a","evidence":"has ] bracket","verdict":"FAIL"}]');
    expect(a).toEqual([{ id: "a", evidence: "has ] bracket", verdict: "FAIL" }]);
  });
  it("returns null when no JSON array is present", () => {
    expect(extractJsonArray("no array here {\"id\":1}")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/judge.test.ts -t extractJsonArray`
Expected: FAIL — `extractJsonArray` is not exported.

- [ ] **Step 3: Implement `extractJsonArray`**

In `eval/judge.ts`, add after `extractJson`:

```ts
/**
 * Return the last top-level balanced JSON array in `text` that parses to an
 * array, or null. Mirrors extractJson but for the judge's per-criterion output.
 */
export function extractJsonArray(text: string): unknown[] | null {
  const arrs: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        arrs.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (let k = arrs.length - 1; k >= 0; k--) {
    try {
      const a = JSON.parse(arrs[k]!);
      if (Array.isArray(a)) return a;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/judge.test.ts -t extractJsonArray`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eval/judge.ts eval-test/judge.test.ts
git commit -m "feat(eval): extractJsonArray for per-criterion judge output"
```

---

## Task 2: Shared deterministic checks (`eval/assertions/checks.ts`)

**Files:**
- Create: `eval/assertions/checks.ts`
- Modify: `eval/assertions/container-registered.ts`, `eval/assertions/manifest-initialized.ts`, `eval/assertions/wake-phrase-set.ts`
- Test: `eval-test/checks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `eval-test/checks.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../test/helpers.js";
import { evaluateCheck } from "../eval/assertions/checks.js";

const cleanups: string[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function okhHomeWith(name: string, module?: string): Promise<string> {
  const home = await makeTempDir(); cleanups.push(home);
  const c = join(home, "containers", name);
  await mkdir(join(c, ".okh"), { recursive: true });
  const mods = module ? `modules:\n  - path: ${module}\n    type: knowledge\n` : "modules: []\n";
  await writeFile(join(c, ".okh", "okh.yaml"), `name: ${name}\nsync: auto\n${mods}`, "utf8");
  await writeFile(join(home, "registry.json"), JSON.stringify({ version: 1, containers: [{ name, backend: "local", localPath: c, addedAt: new Date().toISOString() }] }), "utf8");
  return home;
}

describe("evaluateCheck", () => {
  it("tool: passes when the tool was called", async () => {
    expect((await evaluateCheck({ kind: "tool", name: "add" }, { toolCalls: ["add", "inspect"], transcript: "" })).pass).toBe(true);
    expect((await evaluateCheck({ kind: "tool", name: "sync" }, { toolCalls: ["add"], transcript: "" })).pass).toBe(false);
  });
  it("container: passes for a registered container + module", async () => {
    const okhHome = await okhHomeWith("my-notes", "kb");
    expect((await evaluateCheck({ kind: "container", name: "my-notes", backend: "local", module: "kb" }, { okhHome, transcript: "" })).pass).toBe(true);
    expect((await evaluateCheck({ kind: "container", name: "ghost" }, { okhHome, transcript: "" })).pass).toBe(false);
  });
  it("manifest: passes when the container manifest parses", async () => {
    const okhHome = await okhHomeWith("h");
    expect((await evaluateCheck({ kind: "manifest", name: "h" }, { okhHome, transcript: "" })).pass).toBe(true);
  });
  it("wake-phrase: passes when a non-default phrase is persisted", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    await writeFile(join(home, "preferences.json"), JSON.stringify({ wakePhrase: "brain" }), "utf8");
    expect((await evaluateCheck({ kind: "wake-phrase", default: "hub" }, { okhHome: home, transcript: "" })).pass).toBe(true);
  });
  it("transcript-contains / transcript-absent", async () => {
    expect((await evaluateCheck({ kind: "transcript-contains", pattern: "Plan \\(no changes" }, { transcript: "Plan (no changes made)" })).pass).toBe(true);
    expect((await evaluateCheck({ kind: "transcript-absent", pattern: "error" }, { transcript: "all good" })).pass).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/checks.test.ts`
Expected: FAIL — `checks.ts` does not exist.

- [ ] **Step 3: Create `eval/assertions/checks.ts`**

```ts
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadRegistry, findContainer } from "../../src/registry/registry.js";
import { loadContainerManifest } from "../../src/container/manifest.js";

export type Check =
  | { kind: "tool"; name: string }
  | { kind: "container"; name: string; backend?: string; module?: string }
  | { kind: "manifest"; name: string }
  | { kind: "wake-phrase"; default?: string }
  | { kind: "transcript-contains"; pattern: string }
  | { kind: "transcript-absent"; pattern: string };

export interface CheckContext {
  okhHome?: string;
  toolCalls?: string[];
  transcript: string;
}

export interface CheckResult {
  pass: boolean;
  reason: string;
}

function pathsFor(okhHome: string) {
  return {
    home: okhHome,
    containersDir: join(okhHome, "containers"),
    registryFile: join(okhHome, "registry.json"),
    preferencesFile: join(okhHome, "preferences.json"),
  };
}

export async function checkContainer(
  okhHome: string | undefined,
  opts: { name?: string; backend?: string; module?: string },
): Promise<CheckResult> {
  if (!opts.name || !okhHome) return { pass: false, reason: "missing container name or okhHome" };
  const entry = findContainer(await loadRegistry(pathsFor(okhHome)), opts.name);
  if (!entry) return { pass: false, reason: `no container "${opts.name}" registered` };
  if (opts.backend && entry.backend !== opts.backend) {
    return { pass: false, reason: `backend ${entry.backend} != expected ${opts.backend}` };
  }
  try {
    const manifest = await loadContainerManifest(entry.localPath);
    if (opts.module && !manifest.modules.some((m) => m.path === opts.module)) {
      return { pass: false, reason: `module "${opts.module}" not present` };
    }
  } catch (err) {
    return { pass: false, reason: `invalid manifest: ${(err as Error).message}` };
  }
  return { pass: true, reason: `container "${opts.name}" registered [${entry.backend}]` };
}

export async function checkManifest(okhHome: string | undefined, name?: string): Promise<CheckResult> {
  if (!name || !okhHome) return { pass: false, reason: "missing container name or okhHome" };
  const entry = findContainer(await loadRegistry(pathsFor(okhHome)), name);
  if (!entry) return { pass: false, reason: `no container "${name}"` };
  try {
    await loadContainerManifest(entry.localPath);
    return { pass: true, reason: "manifest initialized" };
  } catch (err) {
    return { pass: false, reason: `manifest missing/invalid: ${(err as Error).message}` };
  }
}

export async function checkWakePhrase(okhHome: string | undefined, def = "hub"): Promise<CheckResult> {
  if (!okhHome) return { pass: false, reason: "missing okhHome" };
  try {
    const prefs = JSON.parse(await readFile(join(okhHome, "preferences.json"), "utf8")) as { wakePhrase?: string };
    if (prefs.wakePhrase && prefs.wakePhrase !== def) {
      return { pass: true, reason: `wake phrase set to "${prefs.wakePhrase}"` };
    }
    return { pass: false, reason: `wake phrase unchanged (${prefs.wakePhrase ?? "none"})` };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { pass: false, reason: "preferences.json not written" };
    return { pass: false, reason: `invalid preferences.json: ${(err as Error).message}` };
  }
}

export async function evaluateCheck(check: Check, ctx: CheckContext): Promise<CheckResult> {
  switch (check.kind) {
    case "tool": {
      const called = (ctx.toolCalls ?? []).includes(check.name);
      return { pass: called, reason: `tool ${check.name} ${called ? "called" : "not called"}` };
    }
    case "container":
      return checkContainer(ctx.okhHome, check);
    case "manifest":
      return checkManifest(ctx.okhHome, check.name);
    case "wake-phrase":
      return checkWakePhrase(ctx.okhHome, check.default);
    case "transcript-contains": {
      const ok = new RegExp(check.pattern, "i").test(ctx.transcript);
      return { pass: ok, reason: ok ? `matched /${check.pattern}/` : `no match /${check.pattern}/` };
    }
    case "transcript-absent": {
      const present = new RegExp(check.pattern, "i").test(ctx.transcript);
      return { pass: !present, reason: present ? `unexpected /${check.pattern}/` : `absent /${check.pattern}/` };
    }
  }
}
```

- [ ] **Step 4: Refactor the three standalone assertions to delegate**

Replace `eval/assertions/container-registered.ts` with:

```ts
import { checkContainer } from "./checks.js";

interface Ctx {
  config?: { name?: string; backend?: string; module?: string };
  providerResponse?: { metadata?: { okhHome?: string } };
}

/** Pass iff the expected container is registered with a valid manifest (and optional module). */
export default async function containerRegistered(_output: string, context: Ctx) {
  const r = await checkContainer(context.providerResponse?.metadata?.okhHome, {
    ...(context.config?.name ? { name: context.config.name } : {}),
    ...(context.config?.backend ? { backend: context.config.backend } : {}),
    ...(context.config?.module ? { module: context.config.module } : {}),
  });
  return { pass: r.pass, score: r.pass ? 1 : 0, reason: r.reason };
}
```

Replace `eval/assertions/manifest-initialized.ts` with:

```ts
import { checkManifest } from "./checks.js";

interface Ctx {
  config?: { name?: string };
  providerResponse?: { metadata?: { okhHome?: string } };
}

/** Pass iff the registered container's manifest exists and parses. */
export default async function manifestInitialized(_output: string, context: Ctx) {
  const r = await checkManifest(context.providerResponse?.metadata?.okhHome, context.config?.name);
  return { pass: r.pass, score: r.pass ? 1 : 0, reason: r.reason };
}
```

Replace `eval/assertions/wake-phrase-set.ts` with:

```ts
import { checkWakePhrase } from "./checks.js";

interface Ctx {
  config?: { default?: string };
  providerResponse?: { metadata?: { okhHome?: string } };
}

/** Pass iff preferences.json holds a wake phrase different from the default. */
export default async function wakePhraseSet(_output: string, context: Ctx) {
  const r = await checkWakePhrase(context.providerResponse?.metadata?.okhHome, context.config?.default ?? "hub");
  return { pass: r.pass, score: r.pass ? 1 : 0, reason: r.reason };
}
```

- [ ] **Step 5: Run tests to verify green**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/checks.test.ts eval-test/assertions.test.ts`
Expected: PASS — new `checks` tests pass AND the existing `assertions.test.ts` (which tests the three standalone assertions) still passes after the refactor.

- [ ] **Step 6: Commit**

```bash
git add eval/assertions/checks.ts eval/assertions/container-registered.ts eval/assertions/manifest-initialized.ts eval/assertions/wake-phrase-set.ts eval-test/checks.test.ts
git commit -m "refactor(eval): shared deterministic check evaluators (checks.ts)"
```

---

## Task 3: `runJudgeCriteria` (self-consistency + majority)

**Files:**
- Modify: `eval/judge.ts`
- Test: `eval-test/judge.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `eval-test/judge.test.ts` (import `runJudgeCriteria`, and `type Criterion` if needed, from `../eval/judge.js`). Use a runner that returns a different canned array per call to simulate k judge runs:

```ts
function seqRunner(outputs: string[]): CopilotRunner {
  let i = 0;
  return async () => ({ transcript: outputs[Math.min(i++, outputs.length - 1)]!, code: 0 });
}

const CRITERIA = [
  { id: "a", text: "criterion a" },
  { id: "b", text: "criterion b" },
];

describe("runJudgeCriteria", () => {
  it("majority-votes each criterion across k runs", async () => {
    const runs = [
      '[{"id":"a","verdict":"PASS"},{"id":"b","verdict":"FAIL"}]',
      '[{"id":"a","verdict":"PASS"},{"id":"b","verdict":"PASS"}]',
      '[{"id":"a","verdict":"FAIL"},{"id":"b","verdict":"FAIL"}]',
    ];
    const res = await runJudgeCriteria(CRITERIA, "transcript", { k: 3, runner: seqRunner(runs) });
    const a = res.find((r) => r.id === "a")!;
    const b = res.find((r) => r.id === "b")!;
    expect(a.verdict).toBe("PASS"); // 2 PASS / 1 FAIL
    expect(a.passVotes).toBe(2);
    expect(b.verdict).toBe("FAIL"); // 1 PASS / 2 FAIL
  });

  it("excludes unparseable runs from the vote", async () => {
    const runs = [
      '[{"id":"a","verdict":"PASS"}]',
      "no json at all",
      '[{"id":"a","verdict":"PASS"}]',
    ];
    const res = await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 3, runner: seqRunner(runs) });
    expect(res[0]!.verdict).toBe("PASS");
    expect(res[0]!.validVotes).toBe(2);
  });

  it("marks a criterion UNRELIABLE when too few valid votes", async () => {
    const runs = ["garbage", "garbage", '[{"id":"a","verdict":"PASS"}]'];
    const res = await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 3, runner: seqRunner(runs) });
    expect(res[0]!.verdict).toBe("UNRELIABLE"); // 1 valid < ceil(3/2)=2
  });

  it("marks a tie UNRELIABLE", async () => {
    const runs = ['[{"id":"a","verdict":"PASS"}]', '[{"id":"a","verdict":"FAIL"}]'];
    const res = await runJudgeCriteria([{ id: "a", text: "a" }], "t", { k: 2, runner: seqRunner(runs) });
    expect(res[0]!.verdict).toBe("UNRELIABLE"); // 1-1 tie
  });

  it("honors OKH_JUDGE_K when k is not passed", async () => {
    const prev = process.env.OKH_JUDGE_K;
    process.env.OKH_JUDGE_K = "1";
    try {
      let calls = 0;
      const runner: CopilotRunner = async () => { calls++; return { transcript: '[{"id":"a","verdict":"PASS"}]', code: 0 }; };
      await runJudgeCriteria([{ id: "a", text: "a" }], "t", { runner });
      expect(calls).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.OKH_JUDGE_K;
      else process.env.OKH_JUDGE_K = prev;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/judge.test.ts -t runJudgeCriteria`
Expected: FAIL — `runJudgeCriteria` is not exported.

- [ ] **Step 3: Implement types + `runJudgeCriteria` + `judgeOnce`**

In `eval/judge.ts`, add the imports at the top if missing (`mkdtemp, mkdir, rm` are already imported). Add the types and functions (place `judgeOnce` above `runJudge`, and `runJudgeCriteria` below it):

```ts
export interface Criterion {
  id: string;
  text: string;
  required?: boolean;
  check?: unknown; // opaque here; interpreted by the judge assertion via checks.ts
}

export interface CriterionResult {
  id: string;
  verdict: "PASS" | "FAIL" | "UNRELIABLE";
  passVotes: number;
  failVotes: number;
  validVotes: number;
  evidence: string[];
}

/** Run one `copilot -p` grading call in an isolated, empty COPILOT_HOME; return raw stdout. */
async function judgeOnce(
  prompt: string,
  opts: { model?: string; timeoutMs?: number; runner?: CopilotRunner },
): Promise<string> {
  const runner = opts.runner ?? spawnCopilot;
  const root = await mkdtemp(join(tmpdir(), "okh-judge-"));
  const copilotHome = join(root, "copilot-home");
  const workspace = join(root, "workspace");
  await mkdir(copilotHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try {
    const res = await runner({
      prompt,
      model: opts.model ?? "claude-sonnet-4.5",
      copilotHome,
      cwd: workspace,
      timeoutMs: opts.timeoutMs ?? 180_000,
    });
    return res.transcript;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function gradeCriteriaPrompt(criteria: Criterion[], transcript: string): string {
  const list = criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n");
  return `You are grading an AI agent's run against a checklist of yes/no criteria. Judge ONLY from the transcript.
Respond with ONLY a JSON array (no prose, no code fences), exactly one object per criterion:
[{"id":"<criterion id>","verdict":"PASS"|"FAIL","evidence":"<short quote or reason>"}]
Include every criterion id exactly once. "verdict" must be exactly "PASS" or "FAIL".

CRITERIA:
${list}

AGENT TRANSCRIPT (what the agent did and said):
${transcript}`;
}

/**
 * Grade a transcript against binary criteria using k independent Copilot-CLI judge
 * runs, then majority-vote each criterion. A run whose output doesn't parse (or
 * omits a criterion) does not vote for it. A criterion with fewer than ceil(k/2)
 * valid votes, or a tie, is UNRELIABLE. k defaults to opts.k, else OKH_JUDGE_K, else 3.
 */
export async function runJudgeCriteria(
  criteria: Criterion[],
  transcript: string,
  opts: { k?: number; model?: string; timeoutMs?: number; runner?: CopilotRunner } = {},
): Promise<CriterionResult[]> {
  const envK = Number(process.env.OKH_JUDGE_K);
  const k = opts.k ?? (Number.isFinite(envK) && envK >= 1 ? Math.floor(envK) : 3);
  const prompt = gradeCriteriaPrompt(criteria, transcript);
  const votes: Array<Map<string, "PASS" | "FAIL">> = [];
  const evidence = new Map<string, string[]>();
  for (let i = 0; i < k; i++) {
    const raw = await judgeOnce(prompt, opts);
    const arr = extractJsonArray(raw);
    if (!arr) continue;
    const m = new Map<string, "PASS" | "FAIL">();
    for (const item of arr) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>;
        const id = rec.id;
        const v = rec.verdict;
        if (typeof id === "string" && (v === "PASS" || v === "FAIL")) {
          m.set(id, v);
          if (typeof rec.evidence === "string" && rec.evidence) {
            const l = evidence.get(id) ?? [];
            l.push(rec.evidence);
            evidence.set(id, l);
          }
        }
      }
    }
    votes.push(m);
  }
  const need = Math.ceil(k / 2);
  return criteria.map((c) => {
    let passVotes = 0;
    let failVotes = 0;
    for (const m of votes) {
      const v = m.get(c.id);
      if (v === "PASS") passVotes++;
      else if (v === "FAIL") failVotes++;
    }
    const validVotes = passVotes + failVotes;
    let verdict: CriterionResult["verdict"];
    if (validVotes < need) verdict = "UNRELIABLE";
    else if (passVotes > failVotes) verdict = "PASS";
    else if (failVotes > passVotes) verdict = "FAIL";
    else verdict = "UNRELIABLE";
    return { id: c.id, verdict, passVotes, failVotes, validVotes, evidence: evidence.get(c.id) ?? [] };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/judge.test.ts -t runJudgeCriteria`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add eval/judge.ts eval-test/judge.test.ts
git commit -m "feat(eval): self-consistent per-criterion judge (runJudgeCriteria)"
```

---

## Task 4: Rewrite the judge assertion (criteria + cross-check + gate)

**Files:**
- Modify: `eval/assertions/judge.ts`
- Modify: `eval/judge.ts` (remove now-unused `runJudge` + `gradePrompt`)
- Test: `eval-test/judge-assertion.test.ts` (new); `eval-test/judge.test.ts` (drop `runJudge` tests)

- [ ] **Step 1: Write the failing test**

Create `eval-test/judge-assertion.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../test/helpers.js";
import judge from "../eval/assertions/judge.js";
import type { CriterionResult } from "../eval/judge.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Build an injectable deps object whose runJudgeCriteria returns canned verdicts. */
function fakeJudge(results: Array<Partial<CriterionResult> & { id: string; verdict: CriterionResult["verdict"] }>) {
  const full: CriterionResult[] = results.map((r) => ({
    id: r.id,
    verdict: r.verdict,
    passVotes: r.passVotes ?? (r.verdict === "PASS" ? 3 : 0),
    failVotes: r.failVotes ?? (r.verdict === "FAIL" ? 3 : 0),
    validVotes: r.validVotes ?? 3,
    evidence: [],
  }));
  return { runJudgeCriteria: async () => full };
}

async function okhHomeWith(name: string, module?: string): Promise<string> {
  const home = await makeTempDir(); cleanups.push(home);
  const c = join(home, "containers", name);
  await mkdir(join(c, ".okh"), { recursive: true });
  const mods = module ? `modules:\n  - path: ${module}\n    type: knowledge\n` : "modules: []\n";
  await writeFile(join(c, ".okh", "okh.yaml"), `name: ${name}\nsync: auto\n${mods}`, "utf8");
  await writeFile(join(home, "registry.json"), JSON.stringify({ version: 1, containers: [{ name, backend: "local", localPath: c, addedAt: new Date().toISOString() }] }), "utf8");
  return home;
}

describe("judge assertion", () => {
  it("passes when all required criteria PASS and cross-checks agree", async () => {
    const okhHome = await okhHomeWith("my-notes", "kb");
    const r = await judge(
      "transcript",
      {
        config: { criteria: [
          { id: "previewed", text: "previewed" },
          { id: "created", text: "created", check: { kind: "container", name: "my-notes", module: "kb" } },
        ] },
        providerResponse: { metadata: { okhHome, toolCalls: ["add"] } },
      },
      fakeJudge([{ id: "previewed", verdict: "PASS" }, { id: "created", verdict: "PASS" }]),
    );
    expect(r.pass).toBe(true);
  });

  it("fails and flags a judge/deterministic disagreement", async () => {
    const okhHome = await okhHomeWith("other"); // "my-notes" NOT registered
    const r = await judge(
      "t",
      {
        config: { criteria: [{ id: "created", text: "created", check: { kind: "container", name: "my-notes" } }] },
        providerResponse: { metadata: { okhHome, toolCalls: [] } },
      },
      fakeJudge([{ id: "created", verdict: "PASS" }]),
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/DISAGREE/);
  });

  it("fails when a required criterion is UNRELIABLE", async () => {
    const r = await judge(
      "t",
      { config: { criteria: [{ id: "x", text: "x" }] }, providerResponse: { metadata: {} } },
      fakeJudge([{ id: "x", verdict: "UNRELIABLE", passVotes: 1, failVotes: 0, validVotes: 1 }]),
    );
    expect(r.pass).toBe(false);
  });

  it("advisory (required:false) criterion does not gate", async () => {
    const r = await judge(
      "t",
      {
        config: { criteria: [{ id: "must", text: "m" }, { id: "nice", text: "n", required: false }] },
        providerResponse: { metadata: {} },
      },
      fakeJudge([{ id: "must", verdict: "PASS" }, { id: "nice", verdict: "FAIL" }]),
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/advisory/);
  });

  it("annotates a borderline (split-vote) pass", async () => {
    const r = await judge(
      "t",
      { config: { criteria: [{ id: "x", text: "x" }] }, providerResponse: { metadata: {} } },
      fakeJudge([{ id: "x", verdict: "PASS", passVotes: 2, failVotes: 1, validVotes: 3 }]),
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/borderline/);
  });

  it("fails fast when no criteria are provided", async () => {
    const r = await judge("t", { config: {}, providerResponse: { metadata: {} } });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/no criteria/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/judge-assertion.test.ts`
Expected: FAIL — the assertion still uses the old `rubric`/`threshold` path.

- [ ] **Step 3: Rewrite `eval/assertions/judge.ts`**

Replace the `Ctx` interface and the default export (keep `buildArtifactsSection` and its imports/constants unchanged). New top imports add `runJudgeCriteria`, `type Criterion` and the checks module:

```ts
import { join } from "node:path";
import { runJudgeCriteria, type Criterion } from "../judge.js";
import { evaluateCheck, type Check } from "./checks.js";
import { readTree, diffTrees } from "./_compare.js";
```

New `Ctx` + default export (place after `buildArtifactsSection`):

```ts
interface CriterionConfig {
  id: string;
  text: string;
  required?: boolean;
  check?: Check;
}

interface Ctx {
  config?: {
    criteria?: CriterionConfig[];
    k?: number;
    graderModel?: string;
    artifacts?: ArtifactsConfig;
  };
  providerResponse?: {
    metadata?: { containerPath?: string; fixtureDir?: string; okhHome?: string; toolCalls?: string[] };
  };
}

/**
 * promptfoo `javascript` assertion. Grades the transcript against binary
 * `criteria` using a self-consistent Copilot-CLI judge (k runs, per-criterion
 * majority). Criteria carrying a `check` are cross-validated against deterministic
 * ground truth; a judge/deterministic disagreement fails and is flagged.
 */
export default async function judge(
  output: string,
  context: Ctx,
  deps: { runJudgeCriteria: typeof runJudgeCriteria } = { runJudgeCriteria },
) {
  const criteria = context.config?.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { pass: false, score: 0, reason: "no criteria provided in assertion config" };
  }
  const meta = context.providerResponse?.metadata ?? {};
  let graded = output;
  if (context.config?.artifacts) {
    graded += await buildArtifactsSection(meta, context.config.artifacts);
  }
  const results = await deps.runJudgeCriteria(criteria as Criterion[], graded, {
    ...(context.config?.k ? { k: context.config.k } : {}),
    ...(context.config?.graderModel ? { model: context.config.graderModel } : {}),
  });
  const byId = new Map(results.map((r) => [r.id, r]));
  const checkCtx = { okhHome: meta.okhHome, toolCalls: meta.toolCalls ?? [], transcript: output };

  const parts: string[] = [];
  let pass = true;
  for (const c of criteria) {
    const r = byId.get(c.id);
    const required = c.required !== false;
    if (!r) {
      parts.push(`${c.id}: MISSING`);
      if (required) pass = false;
      continue;
    }
    let effective: "PASS" | "FAIL" | "UNRELIABLE" = r.verdict;
    let note = "";
    if (c.check) {
      const det = await evaluateCheck(c.check, checkCtx);
      if (r.verdict === "UNRELIABLE") {
        note = "✗unreliable";
      } else if ((r.verdict === "PASS") !== det.pass) {
        note = `✗DISAGREE judge=${r.verdict} det=${det.pass ? "PASS" : "FAIL"} (${det.reason})`;
        effective = "FAIL";
      } else {
        note = "✓det";
      }
    }
    if (required && effective !== "PASS") pass = false;
    const border = r.verdict === "PASS" && r.failVotes > 0 ? " (borderline)" : "";
    parts.push(`${c.id}: ${effective} ${r.passVotes}/${r.validVotes}${note ? " " + note : ""}${border}${required ? "" : " [advisory]"}`);
  }
  return { pass, score: pass ? 1 : 0, reason: parts.join(" · ") };
}
```

- [ ] **Step 4: Remove the dead single-shot judge**

In `eval/judge.ts`, delete the now-unused `gradePrompt` function and the `runJudge` function and the `JudgeVerdict` interface (confirm nothing else imports them: `grep -rn "runJudge\b\|JudgeVerdict\|gradePrompt" eval eval-test src` should show only the definitions/tests you're removing). Keep `extractJson`, `extractJsonArray`, `judgeOnce`, `gradeCriteriaPrompt`, `runJudgeCriteria`, and the `Criterion`/`CriterionResult` types.

In `eval-test/judge.test.ts`, delete the `describe("runJudge", ...)` block and remove `runJudge` from the import (keep `extractJson`, `extractJsonArray`, `runJudgeCriteria`).

- [ ] **Step 5: Run tests to verify green**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/judge.test.ts eval-test/judge-assertion.test.ts && npm run typecheck:eval`
Expected: PASS + typecheck clean (no dangling references to `runJudge`).

- [ ] **Step 6: Commit**

```bash
git add eval/assertions/judge.ts eval/judge.ts eval-test/judge.test.ts eval-test/judge-assertion.test.ts
git commit -m "feat(eval): criteria-based judge assertion with deterministic cross-check"
```

---

## Task 5: Migrate all 15 scenarios to `criteria`

**Files:**
- Modify: every `eval/scenarios/*/test.yaml`

For each scenario below, **replace only the `judge` assertion block** (the `- type: javascript / value: file://assertions/judge.ts` entry that currently has `threshold`/`rubric`) with the `criteria` version shown. **Leave every other assertion unchanged** (`tools-called`, `transcript`, `okf-valid`, `memory-append`, `git-committed`, `module-unchanged`, `container-registered`, `manifest-initialized`, `wake-phrase-set`). Preserve `artifacts` where noted.

- [ ] **Step 1: `ask-grounded`**

```yaml
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

- [ ] **Step 2: `ask-declines-when-absent`**

```yaml
    - type: javascript
      value: file://assertions/judge.ts
      config:
        criteria:
          - id: declines
            text: The answer states the vacation-policy information is NOT in the knowledge base (declines / says not found).
          - id: no-fabrication
            text: The answer does NOT fabricate a vacation policy.
```

- [ ] **Step 3: `context-assembly`**

```yaml
    - type: javascript
      value: file://assertions/judge.ts
      config:
        criteria:
          - id: includes-auth
            text: The response assembles a compact working set that includes the Auth knowledge concept and cites module paths.
          - id: omits-irrelevant
            text: It omits clearly irrelevant items and notes any gaps (does not dump everything).
```

- [ ] **Step 4: `context-includes-skills-tools`**

```yaml
    - type: javascript
      value: file://assertions/judge.ts
      config:
        criteria:
          - id: selects-skill-and-tool
            text: The working set selects the Debugging skill and the csv2json tool, each cited by path.
          - id: one-line-why
            text: It notes one line on why each selected item matters.
          - id: no-auth-pad
            text: It does NOT pad the set with the unrelated Auth knowledge concept.
```

- [ ] **Step 5: `learn-rejects-trivial`**

```yaml
    - type: javascript
      value: file://assertions/judge.ts
      config:
        criteria:
          - id: rejects-trivial
            text: The okf-learn gate REJECTS "the sky is blue" as not serving any goal and does not write it as a concept.
```

- [ ] **Step 6: `learn-integrates`**

```yaml
    - type: javascript
      value: file://assertions/judge.ts
      config:
        criteria:
          - id: integrated-rs256
            text: A valid OKF knowledge concept capturing the RS256 / weekly-key-rotation fact was added to the knowledge module.
          - id: persisted-via-sync
            text: The change was persisted via the sync tool.
            check: { kind: tool, name: sync }
```

- [ ] **Step 7: `remember-records`** (keep `artifacts`)

```yaml
    - type: javascript
      value: file://assertions/judge.ts
      config:
        artifacts: { module: mem }
        criteria:
          - id: recorded-incident
            text: A factual, timestamped memory entry capturing the 500s incident was recorded (see the ON-DISK ARTIFACTS).
```

- [ ] **Step 8: `remember-no-conclusions`** (keep `artifacts`)

```yaml
    - type: javascript
      value: file://assertions/judge.ts
      config:
        artifacts: { module: mem }
        criteria:
          - id: raw-fact-only
            text: The memory entry (see ON-DISK ARTIFACTS) records the raw fact/result only — a timestamped observation.
          - id: no-conclusions
            text: The entry does NOT synthesize conclusions, lessons, recommendations, or root-cause analysis.
```

- [ ] **Step 9: `reflect-insights`**

```yaml
    - type: javascript
      value: file://assertions/judge.ts
      config:
        criteria:
          - id: identifies-pattern
            text: The reflection identifies the recurring token-refresh / clock-skew pattern across BOTH memory entries (2026-01-01 and 2026-02-15), citing each.
          - id: lesson-and-update
            text: It draws a high-signal lesson from the recurrence and proposes a concrete update.
```

- [ ] **Step 10: `onboard-create-local`**

```yaml
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

- [ ] **Step 11: `onboard-add-existing-folder`**

```yaml
    - type: javascript
      value: file://assertions/judge.ts
      config:
        criteria:
          - id: previewed-before-init
            text: The agent previewed the change before initializing the folder as a hub.
          - id: registered-notes
            text: The existing "notes" folder was registered as a local container.
            check: { kind: container, name: notes, backend: local }
          - id: manifest-initialized
            text: An OKH manifest was initialized for "notes".
            check: { kind: manifest, name: notes }
```

- [ ] **Step 12: `onboard-add-github`**

```yaml
    - type: javascript
      value: file://assertions/judge.ts
      config:
        criteria:
          - id: cloned-registered-git
            text: The repo was cloned and registered as a git container with a "kb" knowledge module.
            check: { kind: container, name: okh-eval-hub, backend: git, module: kb }
          - id: used-inspect
            text: The agent inspected the hub's contents.
            check: { kind: tool, name: inspect }
          - id: summarized-kb-content
            text: The agent summarized the repo's actual knowledge content (from the kb module).
```

- [ ] **Step 13: `onboard-explains`**

```yaml
    - type: javascript
      value: file://assertions/judge.ts
      config:
        criteria:
          - id: explains-containers-modules
            text: The agent explains OKH as containers of typed modules.
          - id: offers-setup-help
            text: The agent offers to help the user set up or add a first hub.
```

- [ ] **Step 14: `onboard-wake-phrase`**

```yaml
    - type: javascript
      value: file://assertions/judge.ts
      config:
        criteria:
          - id: explained-onboarding
            text: The agent explained getting started / onboarding.
          - id: set-wake-phrase
            text: The agent set the wake phrase to "brain".
            check: { kind: wake-phrase, default: hub }
          - id: called-onboard
            text: The agent used the onboard tool.
            check: { kind: tool, name: onboard }
```

- [ ] **Step 15: `ask-multi-container`**

```yaml
    - type: javascript
      value: file://assertions/judge.ts
      config:
        criteria:
          - id: answered-with-citations
            text: The agent answered from the registered knowledge modules with module-path citations.
          - id: spans-hubs
            text: The answer draws on more than one hub where the relevant facts live.
          - id: no-fabrication
            text: The agent invented nothing.
```

- [ ] **Step 16: Validate structure**

Run: `npm run eval:validate`
Expected: `Configuration is valid.` (all scenarios parse; the criteria configs are well-formed).

- [ ] **Step 17: Commit**

```bash
git add eval/scenarios
git commit -m "test(eval): migrate all scenarios to binary judge criteria"
```

---

## Task 6: Docs + final verification

**Files:**
- Modify: `eval/README.md`

- [ ] **Step 1: Document the judge model in `eval/README.md`**

Add a section (place it near the automated-eval description):

```markdown
## Judge reliability

The judge grades each scenario against a list of **binary criteria** (not a 0–1
score). For robustness it uses **self-consistency**: the agent runs once, then the
Copilot-CLI judge grades that transcript **`k` times** (default 3, override with
`config.k` per assertion or the `OKH_JUDGE_K` env var) and each criterion is
decided by **majority vote**. A criterion with fewer than `ceil(k/2)` valid votes,
or a tie, is `UNRELIABLE` (fails).

Any criterion that is objectively checkable carries a `check` (`tool`, `container`,
`manifest`, `wake-phrase`, `transcript-contains`, `transcript-absent`). The judge
still grades it, but its majority verdict is **cross-checked against deterministic
ground truth**; a judge/deterministic disagreement fails the scenario and is
flagged in the reason. A green result is therefore reproducible within majority
tolerance and self-auditing.

Cost: one agent call + `k` judge calls per scenario. Set `OKH_JUDGE_K=1` for cheap
local iteration.
```

- [ ] **Step 2: Full eval verification**

Run: `npm run typecheck:eval`
Expected: clean.

Run: `npm run test:eval`
Expected: all eval unit tests pass — `judge.test.ts` (extractJson, extractJsonArray, runJudgeCriteria, buildArtifactsSection), `checks.test.ts`, `judge-assertion.test.ts`, and the existing `assertions.test.ts`/`provision.test.ts`/`provider.test.ts`/`okh-eval.test.ts`/`config.test.ts`/`copilot.test.ts`/`smoke.test.ts`.

Run: `npm run eval:validate`
Expected: `Configuration is valid.`

Run: `npm test`
Expected: core suite unaffected (this work touched only `eval/`), still green.

- [ ] **Step 3: Confirm no dead references**

Run: `git grep -n "runJudge\b\|JudgeVerdict\|threshold" eval eval-test`
Expected: no matches for `runJudge`/`JudgeVerdict`; no `threshold` remaining in any scenario `judge` config (only unrelated matches, if any, are acceptable — verify by eye).

- [ ] **Step 4: Commit**

```bash
git add eval/README.md
git commit -m "docs(eval): document self-consistent judge + cross-check"
```

---

## Optional (non-CI) live validation

After the plan is green, a live run confirms the end-to-end behavior (premium cost;
not a CI gate). With the default `k=3` this is 1 agent + 3 judge calls per scenario:

```bash
npm run build            # judge grades the agent that runs the built dist server
OKH_JUDGE_K=3 npm run eval
```

Expect the two previously-flaky scenarios (`onboard-create-local`,
`onboard-explains`) to pass stably, with per-criterion vote tallies and any
cross-check confirmations in the reason column.

