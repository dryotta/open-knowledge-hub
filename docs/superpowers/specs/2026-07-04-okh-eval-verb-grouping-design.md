# OKH eval: verb-grouped scenarios + View Results verb filter

Date: 2026-07-04
Status: Approved (design)

## Problem

The 16 eval scenarios live in a flat `eval/scenarios/<name>/` layout. The user wants
them organized by the key OKH verb (onboard, ask, context, remember, reflect, learn) and
to be able to filter/group by verb in the promptfoo viewer, ideally as separate
"datasets" with named IDs.

## Constraints (promptfoo, verified in source)

- **Dataset id is always `sha256(JSON.stringify(config.tests))`** — there is no config
  field to name a dataset (`main.js` storeEval). The Datasets tab shows the hash.
- **One eval run = exactly one dataset.** Per-verb *datasets* would require one eval per
  verb, splitting the single combined 16-row results grid.
- **View Results has a native Metadata filter** (filter types include `metadata`, with
  operators equals/not_equals/contains/…, backed by a metadata-keys endpoint), so
  per-test `metadata` is filterable/groupable in the combined grid.

## Decision

Keep **one combined eval → one dataset → one unified results grid**, and express the verb
as **on-disk grouping + a `verb` metadata field** (chosen over per-verb eval runs, which
would fragment the grid). The dataset-id-as-name request is not achievable and is
satisfied instead by verb metadata, prompt labels, and row descriptions.

## Design

### 1. On-disk layout

Group the flat scenario folders under 6 verb directories (leaf keeps `test.yaml` +
`prompt.md`):

```
eval/scenarios/
  onboard/{create-local, add-existing-folder, add-github, explains, phrase, wake-phrase}/
  ask/{grounded, declines-when-absent, multi-container}/
  context/{assembly, includes-skills-tools}/
  remember/{records, no-conclusions}/
  reflect/{insights}/
  learn/{integrates, rejects-trivial}/
```

### 2. Stable identifiers (no churn)

The scenario id stays `<verb>-<case>` (e.g. `onboard-create-local`). Unchanged:
`scenario` var, prompt `label`, per-test `prompts:` filter, `description`, run-state keys.
Only the folder path changes. The harness reconstructs id = `<verb>-<case>` from
`scenarios/<verb>/<case>/` (verb = parent dir, case = leaf dir).

### 3. Verb filtering

Add `metadata: { verb: <verb> }` to each `test.yaml`. In View Results, filter with
`Metadata: verb equals onboard` (etc.). `metadata` is part of `config.tests`, so it stays
within the single dataset (no fragmentation).

### 4. Config + harness updates

- `eval/promptfooconfig.yaml`: tests glob → `file://scenarios/*/*/test.yaml`; update the
  16 explicit prompt `id` paths to `scenarios/<verb>/<case>/prompt.md` (labels unchanged).
- `eval/okh-eval.ts`: `listScenarios`/`loadScenario` walk two levels; build id map
  `<verb>-<case>` → `{verb, dir}`; load `test.yaml` + `prompt.md` from the leaf.
- `eval-test/config.test.ts`: discover nested dirs; assert each scenario has a prompt
  entry, a `prompts:[id]` filter, a `prompt.md`, and `metadata.verb` matching its parent
  folder; keep the "all 16 scenarios" coverage check (now over 6 verb groups).
- `eval-test/okh-eval.test.ts`: unchanged behavior; still loads `ask-grounded`, expects 16.
- `eval/MANUAL-TESTING.md`: update scenario path references to `<verb>/<case>`.

### 5. Unchanged / out of scope

- The custom copilot provider, assertions, judge, fixtures, and provisioning are
  untouched (provider still receives the rendered prompt; `scenario` var format is stable).
- No per-verb eval runs; no dataset renaming (impossible in promptfoo).

## Verification

- `npm run eval:validate` (Configuration is valid), `npm run typecheck:eval`,
  `npm run test:eval` (all scenarios discovered, verb metadata asserted).
- Offline `echo` run over the new `scenarios/*/*/test.yaml`: expect 16 results, one
  dataset with 16 test cases, `metadata.verb` present on each.
- Manual viewer check: View Results → Metadata filter `verb` shows all 6 values and
  filters correctly.
- Larger change → full live `npm run eval` (16/16) per completion criteria.
