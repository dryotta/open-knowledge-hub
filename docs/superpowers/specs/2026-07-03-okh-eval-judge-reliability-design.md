# Design: Reliable OKH e2e judge (self-consistency + binary criteria + deterministic cross-check)

Date: 2026-07-03
Status: Approved (brainstorming)

## Problem

The OKH e2e eval harness (`eval/`) grades each scenario with two kinds of
assertions:

- **Deterministic** assertions — `tools-called`, `container-registered`,
  `manifest-initialized`, `okf-valid`, `memory-append`, `git-committed`,
  `module-unchanged`, `wake-phrase-set`. These are fully reproducible.
- **An LLM judge** (`eval/assertions/judge.ts` → `eval/judge.ts` `runJudge`) —
  one `copilot -p` call that returns a holistic `{ pass, score, reason }` and
  gates on `score >= threshold` (default 0.8).

The judge is the **sole source of flakiness**. It produces a coarse 0–1 score
against a prose rubric; near the 0.8 boundary, ordinary model/temperature
variation flips pass/fail. In a full-suite run, two scenarios
(`onboard-create-local`, `onboard-explains`) scored 0.65 on *correct* behavior —
every deterministic assertion passed; only the judge wobbled. Copilot CLI
temperature is not controllable, so a single judge call cannot be made
repeatable.

## Goal

Make a green judge result **reproducible within a defined tolerance** and
**self-auditing**, while keeping the judge as a gate and keeping the "no external
grader key" model (still Copilot CLI). Concretely:

1. Replace the holistic 0–1 score + threshold with **explicit binary
   criteria**.
2. Grade with **judge self-consistency**: run the judge `k` times on one agent
   transcript and **majority-vote each criterion**.
3. **Cross-check** any criterion that is also deterministically checkable against
   the objective result; a disagreement **fails and is flagged**.

## Non-goals

- Not re-running the agent multiple times (agent variance is out of scope — the
  observed flakiness was judge-side). Full-scenario repeat is explicitly not
  built.
- Not introducing an external/temperature-controlled grader API or key.
- Not making this suite a required CI gate (it still costs premium requests).
- No change to the deterministic assertions themselves or to product code.

## Approach (selected)

Keep the Copilot-CLI judge but (a) give it a **binary, per-criterion** task,
(b) run it `k` times and majority-vote per criterion, and (c) validate judged
criteria against deterministic ground truth where one exists. Chosen over
"remove the judge / deterministic-only" (user wants a quality gate) and over
"full-scenario repeat" (unnecessary cost; agent wasn't the flake source).

## Section 1 — Structured rubric format

A scenario's `judge` assertion config changes from `{ rubric, threshold }` to a
list of yes/no **criteria**:

```yaml
- type: javascript
  value: file://assertions/judge.ts
  config:
    k: 3                       # optional; default 3 (odd → no per-criterion ties)
    artifacts: { module: kb }  # unchanged; still feeds on-disk files to the judge
    criteria:
      - id: previewed-before-apply
        text: The agent showed/echoed a plan describing what it would create before creating it.
        # no `check` → judged only (subjective)
      - id: created-hub-and-kb
        text: A container "my-notes" was created with a "kb" knowledge module.
        check: { kind: container, name: my-notes, module: kb }
      - id: called-add
        text: The agent used the add tool.
        check: { kind: tool, name: add }
```

Criterion fields:
- `id` (string, unique within the scenario) — stable key for voting/reporting.
- `text` (string) — the yes/no question posed to the judge.
- `required` (boolean, default `true`) — a `false` criterion is graded and
  reported but does not gate.
- `check` (optional) — a deterministic cross-check (Section 3).

`check.kind` values and their deterministic evaluation:
- `tool` — `{ kind: tool, name }` → PASS iff `metadata.toolCalls` includes `name`.
- `container` — `{ kind: container, name, backend?, module? }` → reuses the
  `container-registered` logic (registry has `name`, valid manifest, optional
  backend + module).
- `manifest` — `{ kind: manifest, name }` → reuses `manifest-initialized`.
- `wake-phrase` — `{ kind: wake-phrase, default? }` → reuses `wake-phrase-set`.
- `transcript-contains` — `{ kind: transcript-contains, pattern }` → PASS iff the
  transcript matches the (case-insensitive) regex.
- `transcript-absent` — `{ kind: transcript-absent, pattern }` → PASS iff it does
  not match.

The check evaluators reuse the existing assertion logic (extracted into shared
helpers so `judge.ts` and the standalone assertions share one implementation).

## Section 2 — Self-consistent judge

`eval/judge.ts` gains a criteria-mode alongside the existing `extractJson`
helper (reused):

- New prompt asks the judge to grade **all criteria at once** and reply with
  **only** a JSON array:
  ```json
  [{"id":"previewed-before-apply","verdict":"PASS","evidence":"…"}, …]
  ```
  `verdict` is exactly `"PASS"` or `"FAIL"`.
- New function `runJudgeCriteria(criteria, transcript, { k, model, timeoutMs, runner })`:
  - Runs the judge `k` times (default 3) against the **same** transcript (+ the
    existing `artifacts` section). No agent re-run.
  - Parses each run with a tolerant array extractor (extend `extractJson` to also
    return the last balanced JSON **array**; add `extractJsonArray`).
  - For each criterion, collects the verdicts from **valid** runs (a run that
    didn't parse, or omitted the criterion, does not vote).
  - **Per-criterion majority** across valid votes. `k` odd ⇒ no ties among an
    all-voting set. If a criterion has `< ceil(k/2)` valid votes, its result is
    `unreliable` (treated as FAIL with reason `judge-unreliable: only N/k valid votes`).
  - Returns, per criterion: `{ id, verdict: PASS|FAIL|UNRELIABLE, passVotes, failVotes, validVotes, evidence[] }`, plus each run's `raw` for debugging.

Cost: 1 agent call + `k` judge calls per scenario (`k=3` → 4 premium calls).

## Section 3 — Deterministic cross-check + gating

`eval/assertions/judge.ts` is rewritten to consume `criteria`:

1. Build the graded input (`output` + existing `artifacts` section).
2. `runJudgeCriteria(...)` → per-criterion majority verdicts.
3. For each criterion with a `check`, evaluate the deterministic result from
   `metadata` (`toolCalls`, `okhHome`, `containerPath`, `fixtureDir`) and the
   transcript, then compare to the judge's majority verdict:
   - **Agree** → keep the verdict (recorded as cross-checked ✓).
   - **Disagree** → the criterion **fails** and the run is **flagged** with a
     precise reason, e.g. `criterion "created-hub-and-kb": judge=PASS but deterministic=FAIL (no container "my-notes")`. Rationale: a mismatch means the run's grading is untrustworthy; never silently pass.
4. **Gate:** the assertion passes iff **every `required` criterion** resolves to
   `PASS` **and** no cross-check disagreement occurred **and** no required
   criterion is `UNRELIABLE`.
5. **Reason string** (always returned) summarizes per-criterion outcomes:
   `previewed-before-apply: PASS 3/3 · created-hub-and-kb: PASS 2/3 ✓det · called-add: PASS 3/3 ✓det`. Split votes (e.g. `2/3`) are annotated `(borderline)` even when they pass, so fragile criteria are visible in reports.

Behavioral note on determinism: cross-checked criteria are effectively
deterministic (a judge error is caught, not trusted). Purely-judged criteria are
stabilized by k-way majority. A green result is therefore reproducible up to the
residual chance that a majority of `k` judge runs agree on the wrong answer for a
non-cross-checked criterion — far tighter than a single boundary score.

## Section 4 — Config, migration, testing

**Config knobs:**
- `config.k` per assertion; global override `OKH_JUDGE_K` env (e.g. `k=1` for
  cheap local iteration, larger for high-confidence runs). Default `3`.
- `config.graderModel` and `config.artifacts` are preserved unchanged.

**Migration:** convert the `judge` assertion in **all scenarios** (the 9 original
+ the 6 onboarding) from `rubric`/`threshold` to `criteria`, decomposing each
prose rubric into explicit yes/no criteria and adding a `check` to every
objectively-verifiable one. The old score-threshold path in `judge.ts`/`runJudge`
is removed (single code path); `runJudge` may remain only if still used elsewhere
— otherwise delete it. `eval/okh-eval.ts` (manual `check`) is unaffected: it runs
only the deterministic `SIDE_EFFECT_ASSERTIONS`, not the judge.

**Testing** (`eval-test/`, all deterministic — no live model, using the injectable
`runner`):
- `extractJsonArray` — extracts a trailing JSON array amid prose/fences; returns
  null on garbage.
- `runJudgeCriteria` with a fake runner returning canned per-run arrays:
  unanimous PASS; 2/3 majority PASS; 2/3 majority FAIL; a run with unparseable
  output is excluded and the rest still vote; `< ceil(k/2)` valid votes ⇒
  `UNRELIABLE`.
- `judge.ts` assertion with fakes + fake metadata:
  - all criteria PASS, cross-checks agree ⇒ assertion pass.
  - judge majority PASS but deterministic check FAIL ⇒ assertion fail, reason
    names the disagreeing criterion.
  - a non-required criterion FAIL ⇒ still pass (reported).
  - split vote ⇒ pass but reason annotated `(borderline)`.
  - each `check.kind` evaluator (`tool`, `container`, `manifest`, `wake-phrase`,
    `transcript-contains`, `transcript-absent`) returns the expected result
    against crafted metadata/transcript.

**Verification commands:** `npm run typecheck:eval`, `npm run test:eval`,
`npm run eval:validate` (structure). Live `npm run eval` remains a manual,
premium-cost step (now more reproducible).

## Docs

- Update `eval/README.md`: document the criteria rubric format, `k`/`OKH_JUDGE_K`,
  the self-consistency + cross-check model, and that a green judge result is
  reproducible within majority tolerance.
