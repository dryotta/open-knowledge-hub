# Critical E2E Reliability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live eval outcomes reflect successful tool execution and objective artifacts, then fix the reproduced memory and llmwiki product failures.

**Architecture:** Preserve the existing Promptfoo/Copilot provider shape while adding structured successful tool events, state-dependent scripted turns, and deterministic-authority grading. Migrate the affected memory and llmwiki scenarios to exact artifact checks and natural prompts after the harness can measure them reliably.

**Tech Stack:** TypeScript, Node.js child processes, Vitest, Promptfoo JavaScript assertions, YAML scenarios, Markdown skill resources.

Every commit below must append:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 79ba7b3b-b557-48ef-b4eb-492b7e27d59c
```

---

## File map

**Harness core**

- Modify `eval/copilot.ts` — structured tool lifecycle, successful tool names, stateful conversations.
- Modify `eval/provider/copilotProvider.ts` — strict turn/terminal normalization, failure propagation, structured metadata.
- Modify `eval/judge.ts` — reject failed judge subprocesses.
- Modify `eval/assertions/judge.ts` — deterministic checks own checked-criterion gating.
- Create `eval/assertions/tool-events.ts` — shared tuple/subset/order matching.
- Modify `eval/assertions/tools-called.ts` — string and structured expectations.
- Modify `eval/assertions/checks.ts` — structured tool checks.

**Deterministic artifacts**

- Modify `eval/assertions/memory-append.ts` — exact appended observation and append-only validation.
- Create `eval/assertions/llmwiki-state.ts` — scope, schema, page, catalog/log, and health validation.

**Product resources and fixtures**

- Modify `resources/module-types/memory/skills/remember/SKILL.md`.
- Modify `resources/module-types/llmwiki/skills/initialize/SKILL.md`.
- Modify `resources/module-types/llmwiki/skills/write/SKILL.md`.
- Modify `eval/fixtures/wiki-hub/wiki/index.md`.
- Create `eval/fixtures/wiki-hub/wiki/syntheses/index.md`.

**Scenarios and docs**

- Modify `eval/scenarios/onboard/cold-start-conversation.yaml`.
- Modify `eval/scenarios/initialize/llmwiki.yaml`.
- Modify `eval/scenarios/remember/test-result.yaml`.
- Modify `eval/scenarios/remember/incident.yaml`.
- Modify `eval/scenarios/write/into-wiki.yaml`.
- Modify `eval/scenarios/lint/wiki-health.yaml`.
- Modify `eval/scenarios/ask/llmwiki-compounding.yaml`.
- Modify `eval-test/config.test.ts`.
- Modify `eval/README.md`.

**Tests**

- Modify `eval-test/copilot.test.ts`.
- Modify `eval-test/provider.test.ts`.
- Modify `eval-test/judge.test.ts`.
- Modify `eval-test/judge-assertion.test.ts`.
- Modify `eval-test/assertions.test.ts`.
- Modify `eval-test/checks.test.ts`.

---

### Task 1: Track only completed successful tool calls

**Files:**
- Modify: `eval/copilot.ts:50-163,165-215,233-249,287-329`
- Test: `eval-test/copilot.test.ts:11-175`

- [ ] **Step 1: Write failing parser tests**

Add cases proving that full arguments survive in metadata while failed and incomplete calls do not
enter `tools`:

```ts
it("records full tool lifecycle and exposes only completed successful OKH calls", () => {
  const longInput = "x".repeat(300);
  const p = parseCopilotEvents([
    line({ type: "tool.execution_start", data: {
      toolCallId: "ok", mcpServerName: "open-knowledge-hub", mcpToolName: "run",
      arguments: { container: "wiki-hub", module: "wiki", skill: "write", input: longInput },
    } }),
    line({ type: "tool.execution_complete", data: {
      toolCallId: "ok", success: true, result: { content: "done" },
    } }),
    line({ type: "tool.execution_start", data: {
      toolCallId: "bad", mcpServerName: "open-knowledge-hub", mcpToolName: "sync",
      arguments: { container: "wiki-hub" },
    } }),
    line({ type: "tool.execution_complete", data: {
      toolCallId: "bad", success: false, result: { content: "rejected" },
    } }),
    line({ type: "tool.execution_start", data: {
      toolCallId: "open", mcpServerName: "open-knowledge-hub", mcpToolName: "inspect",
      arguments: { container: "wiki-hub", module: "wiki" },
    } }),
  ].join("\n"), 2);

  expect(p.tools).toEqual(["run"]);
  expect(p.toolEvents).toEqual([
    expect.objectContaining({ turn: 2, callId: "ok", tool: "run", completed: true, success: true }),
    expect.objectContaining({ turn: 2, callId: "bad", tool: "sync", completed: true, success: false }),
    expect.objectContaining({ turn: 2, callId: "open", tool: "inspect", completed: false, success: false }),
  ]);
  expect((p.toolEvents[0]!.arguments as { input: string }).input).toBe(longInput);
  expect(p.render).toContain("…"); // display remains truncated
});
```

Remove the old expectation that `assistant.message.toolRequests` or a start event alone counts as a
called tool.

- [ ] **Step 2: Run the parser test and verify RED**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/copilot.test.ts
```

Expected: FAIL because `ParsedTurn` has no `toolEvents`, failed/incomplete starts still populate
`tools`, and `parseCopilotEvents` has no turn argument.

- [ ] **Step 3: Add structured tool events**

In `eval/copilot.ts`, add:

```ts
export interface ToolEvent {
  turn: number;
  callId: string;
  server: string;
  tool: string;
  arguments: unknown;
  completed: boolean;
  success: boolean;
}
```

Add `toolEvents: ToolEvent[]` to `ParsedTurn`, `ConversationTurn`, and `ConversationResult`. Add
`turn: number` to `CopilotTurnOptions`.

Change the parser signature to:

```ts
export function parseCopilotEvents(jsonl: string, turn = 1): ParsedTurn
```

On `tool.execution_start`, append one `ToolEvent` with full arguments. Keep a
`Map<string, ToolEvent>` by call ID. On `tool.execution_complete`, update only the matching event:

```ts
event.completed = true;
event.success = d.success === true;
```

Derive `tools` after parsing:

```ts
const tools = [...new Set(
  toolEvents
    .filter((e) => e.server === OKH_SERVER && e.completed && e.success)
    .map((e) => e.tool),
)].sort();
```

Do not add names from `assistant.message.toolRequests` or start events. Keep argument/result
truncation only in `render`.

In `runConversation`, pass `turns.length + 1` into the runner, aggregate `toolEvents`, and derive
the conversation's `toolCalls` from successful events.

- [ ] **Step 4: Update fake turn helpers**

Update `fakeRunner` and `turn()` helpers in `eval-test/copilot.test.ts` and
`eval-test/provider.test.ts` to return `toolEvents: []` and accept the new `turn` option. Replace
existing fake `tools: ["ask"]` results with completed successful `toolEvents` so provider metadata
still proves the call. Add a conversation test that events from turns 1 and 2 retain their turn
numbers.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/copilot.test.ts eval-test/provider.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```powershell
git add eval/copilot.ts eval-test/copilot.test.ts eval-test/provider.test.ts
git commit -m "fix(eval): track successful tool completion"
```

---

### Task 2: Add exact tool tuple/order assertions and fail fast

**Files:**
- Create: `eval/assertions/tool-events.ts`
- Modify: `eval/assertions/tools-called.ts`
- Modify: `eval/assertions/checks.ts`
- Modify: `eval/provider/copilotProvider.ts`
- Modify: `eval/judge.ts:107-130`
- Test: `eval-test/assertions.test.ts:22-27`
- Test: `eval-test/checks.test.ts:22-53`
- Test: `eval-test/provider.test.ts`
- Test: `eval-test/judge.test.ts:37-108`

- [ ] **Step 1: Write failing tool-matcher tests**

Add tests with successful events for `run(write)`, `inspect`, and `sync`. Require deep argument
subsets and order:

```ts
const events = [
  { turn: 1, callId: "1", server: "open-knowledge-hub", tool: "run",
    arguments: { container: "wiki-hub", module: "wiki", skill: "write", input: "..." },
    completed: true, success: true },
  { turn: 1, callId: "2", server: "open-knowledge-hub", tool: "inspect",
    arguments: { container: "wiki-hub", module: "wiki" }, completed: true, success: true },
  { turn: 1, callId: "3", server: "open-knowledge-hub", tool: "sync",
    arguments: { container: "wiki-hub" }, completed: true, success: true },
];

expect(toolsCalled("", ctx({ toolEvents: events }, {
  expect: [
    { name: "run", arguments: { module: "wiki", skill: "write" } },
    { name: "inspect", arguments: { module: "wiki" } },
    { name: "sync", arguments: { container: "wiki-hub" } },
  ],
  ordered: true,
})).pass).toBe(true);
```

Add failures for wrong module, reversed order, and `success:false`.

- [ ] **Step 2: Run assertions tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/assertions.test.ts eval-test/checks.test.ts
```

Expected: FAIL because only string names are supported.

- [ ] **Step 3: Implement shared tuple matching**

Create `eval/assertions/tool-events.ts`:

```ts
import type { ToolEvent } from "../copilot.js";

export interface ToolExpectation {
  name: string;
  server?: string;
  arguments?: Record<string, unknown>;
  turn?: number;
}

function subset(expected: unknown, actual: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected as Record<string, unknown>)
      .every(([k, v]) => subset(v, (actual as Record<string, unknown>)[k]));
  }
  return Object.is(expected, actual);
}

export function matchesTool(event: ToolEvent, expected: ToolExpectation): boolean {
  return event.completed &&
    event.success &&
    event.tool === expected.name &&
    event.server === (expected.server ?? "open-knowledge-hub") &&
    (expected.turn === undefined || event.turn === expected.turn) &&
    (expected.arguments === undefined || subset(expected.arguments, event.arguments));
}

export function missingTools(
  events: ToolEvent[],
  expected: Array<string | ToolExpectation>,
  ordered = false,
): Array<string | ToolExpectation> {
  let cursor = 0;
  return expected.filter((item) => {
    const expectation = typeof item === "string" ? { name: item } : item;
    const index = events.findIndex((event, i) => i >= (ordered ? cursor : 0) && matchesTool(event, expectation));
    if (index < 0) return true;
    if (ordered) cursor = index + 1;
    return false;
  });
}
```

Update `tools-called.ts` to read `metadata.toolEvents`, accept
`expect: Array<string | ToolExpectation>` and `ordered?: boolean`, and call `missingTools`.

Extend `Check`'s tool variant with `arguments?` and `turn?`; add `toolEvents` to `CheckContext`; use
`matchesTool` instead of name-only membership.

- [ ] **Step 4: Write failing process-error tests**

Add:

```ts
it("rejects a scenario when a Copilot turn exits non-zero", async () => {
  const provider = new CopilotProvider({ config: { runner: async () => turn({ code: 1 }) } });
  await expect(provider.callApi("prompt", {
    vars: { env: "empty" },
    test: { description: "failure" },
  })).rejects.toThrow(/Copilot turn.*exit code 1/);
});
```

In `eval-test/judge.test.ts`, use a runner returning `{ transcript: "", code: 1 }` and expect
`runJudgeCriteria(...)` to reject with `judge.*exit code 1`.

- [ ] **Step 5: Implement fail-fast process handling**

In `CopilotProvider.callApi`, after `runConversation`:

```ts
if (result.code !== 0) {
  throw new Error(`Copilot turn failed with exit code ${result.code ?? "missing"}`);
}
```

In `judgeOnce`, before returning:

```ts
if (res.code !== 0) {
  throw new Error(`Copilot judge failed with exit code ${res.code ?? "missing"}`);
}
return res.transcript;
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/assertions.test.ts eval-test/checks.test.ts eval-test/provider.test.ts eval-test/judge.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```powershell
git add eval/assertions/tool-events.ts eval/assertions/tools-called.ts eval/assertions/checks.ts eval/provider/copilotProvider.ts eval/judge.ts eval-test/assertions.test.ts eval-test/checks.test.ts eval-test/provider.test.ts eval-test/judge.test.ts
git commit -m "fix(eval): assert successful tool tuples"
```

---

### Task 3: Make multi-turn scripts stateful

**Files:**
- Modify: `eval/copilot.ts:217-329`
- Modify: `eval/provider/copilotProvider.ts:19-32,52-74`
- Modify: `eval/scenarios/onboard/cold-start-conversation.yaml`
- Modify: `eval/scenarios/initialize/llmwiki.yaml`
- Modify: `eval-test/config.test.ts:77-140`
- Test: `eval-test/copilot.test.ts:101-175`
- Test: `eval-test/provider.test.ts:47-71`

- [ ] **Step 1: Replace happy-path guard tests with state tests**

Use:

```ts
responses: [
  { id: "wake", after: "start", when: "wake phrase", send: "call it brain" },
  { id: "container", after: "wake", when: "container", send: "create my-notes" },
  { id: "confirm", after: "container", when: "ready", send: "yes" },
  { id: "wrap-up", after: "confirm", when: "created", send: "how do I use it?" },
],
terminal: { after: "wrap-up", requiredTools: ["add_container"] },
```

Add RED tests proving:

- a `container` reply cannot fire from `start`;
- a state may allow alternatives with `after: ["purpose", "goals"]`;
- unmatched eligible guards return `failure` containing the state and last message;
- terminal state fails when a required successful tool is absent;
- no unguarded terminal reply fires early.

- [ ] **Step 2: Run conversation/provider tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/copilot.test.ts eval-test/provider.test.ts
```

Expected: FAIL because turns have no state/dependency or terminal semantics.

- [ ] **Step 3: Implement state and terminal types**

Replace `Turn` and extend the script/result:

```ts
export interface Turn {
  id: string;
  after: string | string[];
  send: string;
  when?: string;
}

export interface ConversationTerminal {
  after: string;
  requiredTools?: string[];
}

export interface ConversationScript {
  initial: string;
  responses: Turn[];
  terminal?: ConversationTerminal;
  maxTurns?: number;
}

export interface ConversationResult {
  transcript: string;
  toolCalls: string[];
  toolEvents: ToolEvent[];
  turns: ConversationTurn[];
  cost: number;
  code: number | null;
  failure?: string;
}
```

Select only turns whose `after` includes the current state. On selection, set `state = turn.id`.
After each agent turn:

```ts
const terminalReady =
  script.terminal?.after === state &&
  (script.terminal.requiredTools ?? []).every((name) => toolSet.has(name));
if (terminalReady) break;

const idx = selectNext(responses, sent, state, last.lastMessage);
if (idx < 0) {
  failure = `unmatched conversation state "${state}": ${last.lastMessage || "(no agent message)"}`;
  break;
}
```

Single-turn scripts with no responses remain valid and complete after turn 1.

- [ ] **Step 4: Normalize and validate stateful YAML**

Update `normalizeTurns` to require non-empty `id`, `after`, and `send`, accept `after` as string or
string array, preserve optional `when`, and throw on malformed entries. Parse `vars.terminal` into
`ConversationTerminal`. Require `vars.terminal` whenever `vars.turns` is non-empty.

Add structural checks in `eval-test/config.test.ts`: any scenario with `vars.turns` must have unique
turn IDs, valid predecessor IDs (or `start`), and `vars.terminal.after` referencing a turn ID.

After `runConversation`, make `CopilotProvider.callApi` reject any state-machine failure:

```ts
if (result.failure) throw new Error(result.failure);
```

- [ ] **Step 5: Migrate the two multi-turn scenarios**

Use ordered states in `cold-start-conversation.yaml`. Replace its unguarded wrap-up with:

```yaml
- id: wrap-up
  after: create-confirmed
  when: "created|registered|set up|complete"
  send: "Thanks — how would I use it day to day?"
terminal: { after: wrap-up, requiredTools: [onboard, config, add_container] }
```

Give llmwiki initialization states `purpose`, optional `goals`, `scope`, `template`, `tags`,
`sources`, `scope-confirmed`, and `sync-confirmed`. Use `after: [purpose, goals]` for `scope`.
Terminal requires successful `run` and `sync`.

- [ ] **Step 6: Run focused and structural tests**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/copilot.test.ts eval-test/provider.test.ts eval-test/config.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```powershell
git add eval/copilot.ts eval/provider/copilotProvider.ts eval/scenarios/onboard/cold-start-conversation.yaml eval/scenarios/initialize/llmwiki.yaml eval-test/copilot.test.ts eval-test/provider.test.ts eval-test/config.test.ts
git commit -m "fix(eval): make conversations stateful"
```

---

### Task 4: Make deterministic checks authoritative

**Files:**
- Modify: `eval/assertions/judge.ts:95-128`
- Test: `eval-test/judge-assertion.test.ts:38-180`

- [ ] **Step 1: Change tests to the intended authority model**

Replace disagreement expectations with:

```ts
it("passes a checked criterion when deterministic evidence passes despite judge FAIL", async () => {
  const okhHome = await okhHomeWith("my-notes");
  const r = await judge(
    "t",
    { config: { criteria: [
      { id: "created", text: "created", check: { kind: "container", name: "my-notes" } },
    ] }, providerResponse: { metadata: { okhHome, toolEvents: [] } } },
    fakeJudge([{ id: "created", verdict: "FAIL" }]),
  );
  expect(r.pass).toBe(true);
  expect(r.reason).toMatch(/det=PASS.*judge=FAIL/);
});
```

Also require:

- deterministic FAIL gates even when judge PASS;
- deterministic PASS gates successfully when judge is `UNRELIABLE` or missing;
- advisory checked criteria do not gate;
- unchecked semantic criteria retain existing judge behavior.

- [ ] **Step 2: Run judge assertion tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/judge-assertion.test.ts
```

Expected: reverse-disagreement and unreliable checked criteria fail under current code.

- [ ] **Step 3: Implement deterministic authority**

For each criterion with `check`, evaluate it regardless of judge result:

```ts
if (c.check) {
  const det = await evaluateCheck(c.check, checkCtx);
  const judgeVerdict = r?.verdict ?? "MISSING";
  const effective = det.pass ? "PASS" : "FAIL";
  if (required && !det.pass) pass = false;
  parts.push(
    `${c.id}: ${effective} ✓det (${det.reason}; judge=${judgeVerdict})${required ? "" : " [advisory]"}`,
  );
  continue;
}
```

For unchecked criteria, preserve required/advisory handling for `PASS`, `FAIL`, `UNRELIABLE`, and
missing results. Pass `toolEvents` into `checkCtx`.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/judge-assertion.test.ts eval-test/checks.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```powershell
git add eval/assertions/judge.ts eval-test/judge-assertion.test.ts
git commit -m "fix(eval): trust deterministic evidence"
```

---

### Task 5: Enforce verbatim append-only memory

**Files:**
- Modify: `eval/assertions/memory-append.ts`
- Modify: `resources/module-types/memory/skills/remember/SKILL.md`
- Modify: `eval/scenarios/remember/test-result.yaml`
- Modify: `eval/scenarios/remember/incident.yaml`
- Test: `eval-test/assertions.test.ts:65-93`
- Test: `test/run.test.ts:20-34`

- [ ] **Step 1: Add strict memory assertion tests**

Pass `observation` instead of a hard-coded baseline count. Add:

```ts
const observation = "Test suite run #42 finished in 13s with 88 passing.";
await writeFile(
  join(c, "mem", "2026-07-10.md"),
  `# 2026-07-10\n\n## 2026-07-10T17:00:00Z\n\n${observation}\n`,
  "utf8",
);
expect((await memoryAppend("", ctx(
  { containerPath: c, fixtureDir: fx },
  { module: "mem", observation },
))).pass).toBe(true);
```

Add failures for:

- an extra “completed successfully” sentence;
- two added/changed Markdown files;
- two new timestamp entries;
- changed/deleted prior content;
- missing exact observation.

- [ ] **Step 2: Run assertion tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/assertions.test.ts
```

Expected: FAIL because the assertion checks only file count growth.

- [ ] **Step 3: Replace baseline counting with exact diff validation**

Update config to `{ module?: string; observation?: string }`. Read before/after trees and require:

```ts
const changedMarkdown = [...diff.added, ...diff.changed].filter((p) => p.endsWith(".md"));
const priorRewritten = diff.changed.filter((p) => before.has(p) && !after.get(p)!.startsWith(before.get(p)!));
const appended = diff.added.includes(path)
  ? after.get(path)!
  : after.get(path)!.slice(before.get(path)!.length);
```

Require one changed Markdown path, no removed/rewritten history, one new ISO timestamp heading, exact
observation once, and no non-empty appended lines except a file-date heading, an exact timestamp
heading matching `^## \d{4}-\d{2}-\d{2}T\S+$`, and the observation. Return explicit reasons for
each violation.

- [ ] **Step 4: Clarify the product contract**

Replace the summary instruction in `remember/SKILL.md` with:

```markdown
1. Append a single dated entry to a markdown file in this memory module (for example,
   `YYYY-MM-DD.md`), newest entries at the bottom.
2. Each entry contains an ISO timestamp followed by the caller's observation preserved verbatim.
   Keep any concrete references the caller supplied.
3. Do not add a second summary, status, certainty, cause, conclusion, or recommendation. Synthesis
   belongs in `reflect`.
```

Keep the append-only prohibition.

- [ ] **Step 5: Migrate both memory scenarios**

Set each `memory-append` assertion's `observation` to the exact quoted prompt text and remove
`baselineFileCount`. Mark their prose judge criteria `required: false`; the deterministic assertion
now owns factual shape.

- [ ] **Step 6: Run memory and discovery tests**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/assertions.test.ts
npx vitest run test/run.test.ts
```

Expected: all tests pass and vendored `remember` remains discoverable.

- [ ] **Step 7: Commit**

```powershell
git add eval/assertions/memory-append.ts resources/module-types/memory/skills/remember/SKILL.md eval/scenarios/remember/test-result.yaml eval/scenarios/remember/incident.yaml eval-test/assertions.test.ts
git commit -m "fix(memory): preserve observations verbatim"
```

---

### Task 6: Add deterministic llmwiki artifact validation

**Files:**
- Create: `eval/assertions/llmwiki-state.ts`
- Modify: `eval-test/assertions.test.ts`

- [ ] **Step 1: Write failing initialization and write-state tests**

Build temporary before/after wiki trees and assert:

```ts
expect((await llmwikiState("", ctx(meta, {
  module: "new-wiki",
  requiredIndexText: ["backend developers", "product roadmaps", "concept", "synthesis"],
  requiredGroupIndexes: ["concepts/index.md", "entities/index.md", "summaries/index.md", "syntheses/index.md"],
  noContentPages: true,
}))).pass).toBe(true);
```

For writes:

```ts
expect((await llmwikiState("", ctx(meta, {
  module: "wiki",
  expectedNewPage: { folder: "syntheses", type: "synthesis", terms: ["attention", "transformer"] },
  requireIndexAndLogChanged: true,
  requireCleanHealth: true,
}))).pass).toBe(true);
```

Add failures for missing type, wrong folder, absent index/log change, invented initialization page,
and non-clean health.

- [ ] **Step 2: Run assertion tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/assertions.test.ts
```

Expected: FAIL because `llmwiki-state.ts` does not exist.

- [ ] **Step 3: Implement `llmwiki-state.ts`**

Use `readTree`, `diffTrees`, `parseFrontmatter`, `stringField`, and `llmwikiLoader.health`. Support:

```ts
interface Config {
  module?: string;
  requiredIndexText?: string[];
  requiredGroupIndexes?: string[];
  noContentPages?: boolean;
  expectedNewPage?: { folder: string; type: string; terms: string[] };
  requireIndexAndLogChanged?: boolean;
  requireCleanHealth?: boolean;
}
```

Content pages exclude any basename `index.md` and `log.md`. For `expectedNewPage`, inspect only
added Markdown content pages under the configured folder, require exact frontmatter type, and match
all terms case-insensitively across title/body. When requested, require `index.md` and `log.md` in
the changed paths and require all four health arrays to be empty.

Return all problems in one reason string so a failed live run is diagnosable without a judge.

- [ ] **Step 4: Run assertion tests and verify GREEN**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/assertions.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```powershell
git add eval/assertions/llmwiki-state.ts eval-test/assertions.test.ts
git commit -m "test(eval): validate llmwiki artifacts"
```

---

### Task 7: Fix llmwiki disciplines, fixture schema, and scenarios

**Files:**
- Modify: `resources/module-types/llmwiki/skills/initialize/SKILL.md`
- Modify: `resources/module-types/llmwiki/skills/write/SKILL.md`
- Modify: `eval/fixtures/wiki-hub/wiki/index.md`
- Create: `eval/fixtures/wiki-hub/wiki/syntheses/index.md`
- Modify: `eval/scenarios/initialize/llmwiki.yaml`
- Modify: `eval/scenarios/write/into-wiki.yaml`
- Modify: `eval/scenarios/lint/wiki-health.yaml`
- Modify: `eval/scenarios/ask/llmwiki-compounding.yaml`
- Test: `test/run.test.ts`
- Test: `eval-test/config.test.ts`

- [ ] **Step 1: Add resource contract tests**

In `test/run.test.ts`, assert llmwiki skill bodies contain the critical instructions:

```ts
const initialize = await svc.resolveSkill("h", "wiki", "initialize");
expect(initialize.body).toMatch(/must invoke.*grilling/i);
expect(initialize.body).toMatch(/next steps.*not completion/i);

const write = await svc.resolveSkill("h", "wiki", "write");
expect(write.body).toMatch(/omit.*container.*module/i);
expect(write.body).toMatch(/declared.*type/i);
expect(write.body).toMatch(/inspect/i);
```

- [ ] **Step 2: Run resource tests and verify RED**

Run:

```powershell
npx vitest run test/run.test.ts
```

Expected: FAIL because the wording is not explicit enough.

- [ ] **Step 3: Strengthen llmwiki skills**

In `initialize/SKILL.md`, state:

```markdown
You **must invoke** the shared `grilling` skill with `run { skill: "grilling" }`; do not emulate or
summarize its discipline yourself. After agreement, perform Stage 2 in this run. Reporting “next
steps” without writing the contract and group indexes is not completion.
```

Do not override the injected write policy; local edits are followed by diff summary and explicit
sync confirmation.

In `write/SKILL.md`, before authoring state:

```markdown
Recover the declared group folders and exact `type` vocabulary from root `index.md`, then choose a
target path and type from that schema. Invoke the shared writer with only `skill` and `input`
(`run { skill: "okf-writer", input: "..." }`); because it is shared, omit `container` and `module`.
The input must include target path, declared type, source context, and affected cross-links.
```

Retain final `inspect` and require every remaining health item to be resolved or explicitly logged.

- [ ] **Step 4: Declare synthesis in the fixture**

Update root structure to:

```markdown
- **Groups / folders** — `concepts/`, `entities/`, `syntheses/`.
- **Concept types** — `concept`, `entity`, `synthesis`.
```

Create `syntheses/index.md` as a stub group index with no concept frontmatter:

```markdown
# Syntheses

Durable explanations that connect multiple wiki pages.
```

- [ ] **Step 5: Make initialization natural and policy-correct**

The initial prompt should request only the public module skill:

```yaml
prompt: |
  Use the open-knowledge-hub MCP tools. In container "wiki-hub", run module
  "new-wiki"'s `initialize` skill and guide me through setting up the wiki.
```

Keep stateful user answers. `scope-confirmed` says to build locally and report the diff; it does not
authorize sync. `sync-confirmed` separately says “Yes, sync those changes now.”

Add:

```yaml
- type: javascript
  value: file://assertions/llmwiki-state.ts
  config:
    module: new-wiki
    requiredIndexText: [backend developers, product roadmaps, concept, synthesis]
    requiredGroupIndexes: [concepts/index.md, entities/index.md, summaries/index.md, syntheses/index.md]
    noContentPages: true
```

Use ordered structured tool expectations for exact `initialize`, shared `grilling`, and `sync`.
Mark mechanical judge criteria advisory; keep template-menu quality semantic and required.

- [ ] **Step 6: Migrate write/lint/compounding tool assertions**

Replace transcript regexes with structured expectations. Write/compounding require ordered:

1. module `run` with `skill: write`,
2. shared `run` with `skill: okf-writer`,
3. `inspect` for `wiki`,
4. `sync` for `wiki-hub`.

Lint requires exact module `run` with `skill: lint`, successful `inspect`, and `sync`.

For compounding, use the natural prompt:

```yaml
prompt: |
  Use the open-knowledge-hub MCP tools. Ask module "wiki" in container "wiki-hub"
  how Attention fits within a Transformer, then file the durable answer back into
  that wiki and sync it.
```

Add `llmwiki-state.ts` to write and compounding. Write expects a `concepts`/`concept` KV-cache page;
compounding expects a `syntheses`/`synthesis` page with `attention` and `transformer`; both require
index/log changes and clean health. Mark duplicate mechanical judge criteria advisory.

- [ ] **Step 7: Run core and eval structural tests**

Run:

```powershell
npx vitest run test/run.test.ts test/loaders.test.ts test/llmwiki.test.ts
npx vitest run --config vitest.eval.config.ts eval-test/config.test.ts eval-test/assertions.test.ts
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```powershell
git add resources/module-types/llmwiki/skills/initialize/SKILL.md resources/module-types/llmwiki/skills/write/SKILL.md eval/fixtures/wiki-hub/wiki/index.md eval/fixtures/wiki-hub/wiki/syntheses/index.md eval/scenarios/initialize/llmwiki.yaml eval/scenarios/write/into-wiki.yaml eval/scenarios/lint/wiki-health.yaml eval/scenarios/ask/llmwiki-compounding.yaml test/run.test.ts eval-test/config.test.ts
git commit -m "fix(llmwiki): enforce initialization and write contracts"
```

---

### Task 8: Update harness documentation and run complete validation

**Files:**
- Modify: `eval/README.md`
- Verify: all changed files

- [ ] **Step 1: Update current harness documentation**

Correct stale counts/environments and document:

- 25 scenarios and 6 environments;
- successful structured `toolEvents`;
- tuple/order syntax for `tools-called`;
- stateful `{ id, after, when, send }` turns plus terminal requirements;
- unmatched-state and process failures;
- deterministic checks as authoritative;
- exact memory and llmwiki artifact assertions.

Remove the old unguarded-fallback explanation and judge/disagreement gating claim.

- [ ] **Step 2: Run format and static validation**

Run:

```powershell
git --no-pager diff --check
npm run build
npm run typecheck
npm run typecheck:eval
npm run eval:validate
```

Expected: every command exits 0; Promptfoo prints `Configuration is valid.`

- [ ] **Step 3: Run complete deterministic tests**

Run:

```powershell
npm test
npm run test:eval
```

Expected: all core and eval harness tests pass.

- [ ] **Step 4: Commit documentation**

```powershell
git add eval/README.md
git commit -m "docs(eval): document reliable tool and turn checks"
```

- [ ] **Step 5: Build the server before live eval**

Run:

```powershell
npm run build
```

Expected: exit 0. The live harness launches `dist/index.js`.

- [ ] **Step 6: Run targeted live scenarios**

Run one Promptfoo process for the affected cases:

```powershell
node --import tsx node_modules/promptfoo/dist/src/entrypoint.js eval `
  -c eval/promptfooconfig.yaml --no-cache `
  --filter-pattern "Remember - test result|Initialize - llmwiki|Write - in-scope page|Lint - wiki health|Ask - llmwiki compounding"
```

Expected: 5 passed, 0 failed, 0 errors.

- [ ] **Step 7: Run the complete live suite**

Run:

```powershell
npm run eval
```

Expected: 25 passed, 0 failed, 0 errors. Do not rerun a failure without first reading its structured
tool trace and persisted artifacts from the Promptfoo result.

- [ ] **Step 8: Request final code review**

Review the complete branch against
`docs/superpowers/specs/2026-07-10-okh-e2e-critical-reliability-design.md`. Fix every Critical or
Important issue, rerun the smallest affected tests, then repeat the complete static/deterministic
validation.
