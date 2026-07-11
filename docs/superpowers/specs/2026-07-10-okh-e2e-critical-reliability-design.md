# Design: Critical e2e reliability fixes

Date: 2026-07-10
Status: Approved

## 1. Scope

Fix the critical false pass/fail mechanisms in the live eval harness and the reproduced memory and
llmwiki product failures they exposed.

Included:

- successful structured tool tracking and process failure handling;
- stateful multi-turn scripts;
- authoritative deterministic checks;
- memory raw-observation behavior and assertion;
- llmwiki initialize/write behavior and scenario corrections.

Deferred:

- scenario deduplication and count-test replacement;
- network-test isolation;
- broad judge/artifact redesign beyond deterministic authority;
- splitting the suite into separate gate and realism commands.

## 2. Harness truthfulness

### 2.1 Structured tool lifecycle

Parse MCP tool starts and completions by call ID into:

```ts
interface ToolEvent {
  turn: number;
  callId: string;
  server: string;
  tool: string;
  arguments: unknown;
  completed: boolean;
  success: boolean;
}
```

Preserve full arguments in provider metadata. Human-readable transcripts may remain truncated.

Existing name-only assertions derive from completed successful OKH calls. Add deterministic tuple
and ordering checks over server, tool, arguments, and turn. Attempted, incomplete, denied, or failed
calls never satisfy an expected tool.

Copilot provider and judge subprocess timeout, spawn failure, or non-zero exit is an infrastructure
failure before scenario grading.

### 2.2 Stateful conversations

Extend scripted turns with an `id` and `after` dependency (one or more predecessor states). Only
turns eligible from the current state may match. This prevents stale replies and early fallbacks.

Multi-turn scenarios declare a terminal state plus required successful tools. If no eligible turn
matches before the terminal state, return an explicit unmatched-script failure with the current
state and last agent message. Do not treat it as normal completion.

The initialization scenario uses states for purpose/goals, scope, template, tags, source policy,
scope confirmation, and post-edit sync confirmation.

### 2.3 Deterministic checks are authoritative

For judge criteria carrying a deterministic check:

- evaluate the check directly;
- use its result for gating;
- keep judge disagreement only as diagnostic output;
- do not let `FAIL` or `UNRELIABLE` judge votes override objective evidence.

Purely semantic criteria continue to use the existing judge vote.

## 3. Product and scenario corrections

### 3.1 Memory

Change `remember`'s provisional entry format to:

- ISO timestamp;
- caller observation preserved verbatim;
- optional concrete references already supplied by the caller.

Remove the generated factual summary. Do not add status, certainty, causality, conclusions, or
meaning.

Add a deterministic memory assertion that requires:

- exactly one memory Markdown file added or changed, containing exactly one new entry;
- prior entries unchanged;
- the exact supplied observation;
- no additional body claims beyond structural timestamp/heading text.

### 3.2 llmwiki initialization

Strengthen the skill:

- shared `grilling` must be invoked as a real shared skill, not emulated;
- after scope agreement, Stage 2 edits happen immediately;
- describing future steps is not completion;
- after edits, follow the global write policy: summarize the diff, obtain explicit confirmation,
  then sync.

The scenario uses a natural request that names `initialize`, not internal `grilling` or a question
order. Stateful replies answer the requested decisions. A separate final turn confirms sync after
the agent reports the local diff.

Deterministic checks require successful `initialize`, shared `grilling`, and `sync` calls plus the
expected scope contract and empty group indexes.

### 3.3 llmwiki write and ask compounding

Strengthen `write`:

- recover declared group folders and `type` vocabulary before writing;
- choose a target path/type from that schema;
- invoke shared `okf-writer` without container/module arguments and pass target path, type, and
  source context;
- require non-empty type, reciprocal links, catalog/log updates, and final `inspect`;
- do not sync with unhandled structural health defects.

Update the wiki fixture to declare `syntheses/` and `synthesis`, including its group index, before
the compounding scenario requires a synthesis.

Make the compounding user prompt natural: ask the question, then request that the durable answer be
filed back. Remove the exact path and frontmatter instructions. Deterministic disk checks own those
requirements.

## 4. TDD implementation order

1. Tool lifecycle parsing, successful name checks, tuple/order checks, and process failures.
2. Conversation dependency/terminal behavior and unmatched-state errors.
3. Deterministic-authority behavior in judge assertions.
4. Exact memory artifact assertion and `remember` contract.
5. llmwiki skill, fixture, and scenario migration.

Each slice starts with a failing focused test and is verified before the next slice.

## 5. Acceptance

Run:

```text
npm run build
npm run typecheck
npm test
npm run typecheck:eval
npm run test:eval
npm run eval:validate
```

Then build the server and run targeted live memory and llmwiki scenarios followed by the complete
live `npm run eval` suite.

No rerun-until-green behavior, broad guard regexes, larger timeouts, or weakened criteria. Diagnose
any remaining live failure from the structured tool trace and persisted artifacts.
