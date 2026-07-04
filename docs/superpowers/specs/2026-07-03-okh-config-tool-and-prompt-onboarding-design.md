# Design: generic `config` tool + prompt-based multi-turn onboarding

Date: 2026-07-03
Status: Approved (brainstorming)

## Problem

The current `onboard` tool conflates two unrelated jobs:

1. **Guided first-run onboarding.** With no arguments it returns the `onboard`
   discipline text (also available as an `onboard` prompt).
2. **Persisting the wake phrase.** With `{ wakePhrase }` it writes
   `preferences.json`.

This coupling is awkward: onboarding guidance and settings-mutation live in one
tool, there is no general way to view or change configuration, and the wake
phrase is the only setting that can be persisted. We also want onboarding to be
a **prompt-based, multi-turn** experience (intro → wake phrase → first repo +
modules) that the client agent walks through one turn at a time.

## Goal

1. Replace the `onboard` **tool** with a **generic `config` tool** that lists the
   current configuration and modifies it via a generic setter, backed by a
   single extensible schema so future settings need no tool-signature change.
2. Make onboarding **prompt-based and multi-turn**, structured into three
   stages: (1) intro info, (2) changing the wake phrase, (3) setting up the first
   repo + modules. The agent advances one stage per turn, checking in with the
   user.
3. Keep `onboard` exposed as **both a prompt and a thin tool** (per the existing
   "every cognitive verb is prompt + tool" pattern), so prompt-less/headless
   clients and the eval harness continue to work. The thin `onboard` tool
   returns the onboarding discipline only — it no longer sets the wake phrase.

## Non-goals

- No server-side LLM or autonomous reasoning (ADR-0001 stands: deterministic
  tools + discipline text; the client agent does the thinking).
- No server-side onboarding state machine. "Multi-turn" means the discipline
  text instructs the agent to proceed one stage per conversational turn; the
  server stays stateless.
- No new config keys beyond the existing `wakePhrase` — the schema is made ready
  for more, but none are added now.
- No dependency on MCP elicitation or other optional client primitives.

## Current state (reference)

- Config is a single JSON file at `$OKH_HOME/preferences.json`
  (`paths.preferencesFile` in `src/config.ts`), currently `{ "wakePhrase": "hub" }`.
- `src/preferences.ts` owns access:
  - `preferencesSchema` (zod, `.strict()`) is the source of truth; `wakePhraseSchema`
    enforces a 1–32-char regex (`^[a-z][a-z0-9-]{0,31}$/i`).
  - `loadPreferences` / `loadPreferencesSync` parse the file and fall back to the
    default on missing file or parse/validation failure.
  - `savePreferences` validates, then writes **atomically** (temp file + `rename`)
    under a `Mutex`.
- `onboard` is registered as a **tool** (`src/server/tools.ts`) and a **prompt**
  (`src/server/prompts.ts`); both call `buildOnboard(...)` in
  `src/prompts/index.ts`, which injects the current wake phrase + hubs and the
  `resources/discipline/onboard.md` text.
- The eval harness runs `copilot -p … --allow-all` (tool-driven). `OKH_TOOLS` in
  `eval/copilot.ts` lists the tool names. Onboarding scenarios live under
  `eval/scenarios/onboard-*`; `onboard-wake-phrase` asserts the `onboard` tool is
  called and that the wake phrase was persisted.

## Section 1 — `config` tool

### Signature

```
config { set?: Record<string, unknown> }
```

- `config {}` → **list**. Prints the preferences-file path and, for every known
  key, its current effective value and a human description. Also returns
  `structuredContent` with the current preferences and the list of known keys.
- `config { set: { <key>: <value>, … } }` → **modify**. Merges `set` into the
  current preferences, validates the merged object against
  `preferencesSchema.strict()`, persists via `savePreferences`, and echoes the
  updated values. For keys that only take effect on restart (wake phrase), the
  message says so and notes the phrase can already be used immediately.

Annotations: `{ readOnlyHint: false, openWorldHint: false }`. (List is
read-only, set mutates; the tool as a whole is not read-only.)

### Behavior & validation

- **Generic shape, real validation.** The tool signature never changes when a new
  setting is added; validation is entirely delegated to `preferencesSchema`.
- **Unknown keys rejected.** Because the schema is `.strict()`, unknown keys fail
  validation. The tool converts this into an actionable error listing the valid
  keys (from `configFieldMeta`, see below).
- **Per-key rules preserved.** e.g. `wakePhrase` still validates against
  `wakePhraseSchema`; an invalid value returns a clear message with the rule.
- **Partial merge.** `set` merges into current prefs — setting one key never
  clears another.

### `preferences.ts` changes

- Add `configFieldMeta`: a small, ordered array of `{ key, description }` adjacent
  to `preferencesSchema`, used to (a) render the `config {}` list, (b) build the
  `config` tool description, and (c) list valid keys in error messages. Today it
  has one entry for `wakePhrase`. Adding a future setting = add a schema field +
  one `configFieldMeta` entry.
- Add a `mergePreferences(current, patch)` helper (or perform the merge inline in
  the tool) that produces the object passed to `savePreferences`. `savePreferences`
  continues to validate + atomically write.
- No change to storage location or format.

## Section 2 — prompt-based multi-turn onboarding

### Discipline restructure (`resources/discipline/onboard.md`)

Rewrite into three explicit stages, with a preamble instructing the agent to do
**one stage per turn**, check in with the user, and resume at the right stage on
a later message:

1. **Intro info.** Explain OKH in two sentences (containers of typed modules —
   `knowledge`, `skills`, `tools`, `memory`, `project`; the client does the
   thinking, OKH stores/validates/syncs). Show current state from the injected
   hub list; if none are registered, say so.
2. **Wake phrase.** Explain the wake phrase (current value is injected; default
   `hub`) and why naming the hub improves routing. If the user wants a different
   phrase, call **`config { set: { wakePhrase: "<choice>" } }`** (no longer the
   `onboard` tool). Note it takes effect on the next client restart and mention
   the optional MCP-client-key rename for the most reliable routing.
3. **First repo + modules.** Offer: an existing folder, a brand-new local folder,
   or a git repo to clone. Call `add` (which returns a plan; confirm; re-call with
   `create: true`). After a container exists, offer to add a `knowledge` module
   the same way.

Close with a pointer to everyday use (USAGE.md) and the invariant: never create
folders, init manifests, or sync without explicit confirmation.

### `buildOnboard(...)` (`src/prompts/index.ts`)

- Continue injecting the current wake phrase + hub list.
- Update surrounding prose so wake-phrase changes route to `config`, not to an
  `onboard { wakePhrase }` call.

## Section 3 — server wiring & instructions

- `src/server/tools.ts`:
  - Remove the old `onboard` tool handler (with its `wakePhrase` side effect).
  - Register the new `config` tool (list + set), using `paths` and the
    `preferences.ts` helpers.
  - Register a **thin `onboard` tool** that returns the onboarding discipline
    (via `buildOnboard`) with no arguments and no side effects — mirroring the
    `onboard` prompt.
- `src/server/index.ts` `buildInstructions(...)`: mention that settings are
  managed via `config`, and first-run setup via the `onboard` prompt/tool. Keep
  the wake-phrase announcement.
- `src/server/prompts.ts`: the `onboard` prompt is unchanged in registration; it
  keeps rendering `buildOnboard(...)` (now with the restructured discipline).

## Section 4 — docs

- `README.md`:
  - Tools table: `onboard` row no longer lists a `wakePhrase` arg; add a `config`
    row (`set?` — list/modify configuration).
  - "Change the wake phrase" line: use the `config` tool; storage path unchanged.
- `USAGE.md`:
  - "Choosing a wake phrase": persisted via the `config` tool (not `onboard`).
  - "Getting started": still `hub, help me get started` → guided `onboard` flow.

## Section 5 — tests & evals

- `test/server.test.ts`:
  - `config {}` lists current config including `wakePhrase`.
  - `config { set: { wakePhrase } }` persists a valid phrase; rejects an invalid
    phrase and an unknown key with actionable messages.
  - Thin `onboard` tool returns onboarding discipline and does not mutate prefs.
  - Update/replace any existing test that exercised `onboard { wakePhrase }`.
- Evals:
  - `eval/copilot.ts`: add `config` to `OKH_TOOLS`.
  - `eval/scenarios/onboard-wake-phrase/test.yaml`: update the `tools-called`
    expectation and the judge `check` for wake-phrase from the `onboard` tool to
    the `config` tool. The `wake-phrase-set` assertion is unaffected (it reads
    `preferences.json`). Keep an assertion that onboarding was explained.
  - Other `onboard-*` scenarios (explains, add-github, add-existing-folder,
    add-create-local) are unchanged.

### Verification

- Core: `npm run typecheck`, `npm test`, `npm run build`.
- Eval harness: `npm run typecheck:eval`, `npm run eval:validate`,
  `npm run test:eval`.
- Because this is a moderate change touching the eval scenarios, run the full
  end-to-end `npm run eval` as part of completion criteria.

## Risks & mitigations

- **Prompt-less clients lose the wakePhrase-setting shortcut.** Mitigated: the
  generic `config` tool is a normal tool and works everywhere; onboarding stays
  available as a thin tool too.
- **Eval drift.** Only `onboard-wake-phrase` and `OKH_TOOLS` change; other
  scenarios are untouched, limiting blast radius.
