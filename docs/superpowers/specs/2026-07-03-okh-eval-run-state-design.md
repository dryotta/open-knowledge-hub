# Design: Frictionless manual eval runs (run-state pointer)

Date: 2026-07-03
Status: Approved (brainstorming)

## Problem

The manual eval flow (`eval/okh-eval.ts`, documented in `eval/MANUAL-TESTING.md`)
provisions each scenario into a **random** temp directory via `mkdtemp`
(`<tmp>/okh-eval-<scenario>-XXXXX`) and prints its `Root`. Every follow-up step
then requires the operator to **copy-paste that random path**:

- entering an interactive session (`$env:COPILOT_HOME=…\copilot-home`,
  `Set-Location …\workspace`, `copilot --allow-all`),
- `npm run eval:setup -- check <root> --scenario <name>`,
- `npm run eval:setup -- clean <root>`.

This is error-prone and unfriendly, especially since the path is long and used
several times per scenario.

## Goal

Eliminate path copy-pasting. After `setup`, follow-up commands should work **by
scenario name or with no argument**, resolving the path automatically. Keep
free-form exploratory testing fully interactive (`setup <fixture-scenario>` →
`enter`), with **no** automatic capture/dumping of prompts or diffs.

## Non-goals

- No automatic capture of prompts, transcripts, or container diffs. Exploration
  stays interactive; the operator inspects results by hand as today.
- No reading of Copilot CLI's internal session storage.
- No change to the automated promptfoo pipeline (`npm run eval`).

## Approach (selected)

**Run-state pointer.** Keep provisioning unique temp dirs (parallel-safe,
`provision.ts` unchanged). `setup` records the run in a small, disposable state
file. `enter` / `check` / `clean` resolve the path from that state — by scenario
name, or the most-recent run when no name is given. Explicit-path forms remain
accepted so existing behavior and unit tests are unaffected.

### New module: `eval/run-state.ts`

State file lives at a fixed, disposable location: `<os.tmpdir()>/okh-eval-state.json`
(kept out of the repo — nothing to gitignore). Shape:

```jsonc
{
  "runs": [
    {
      "scenario": "ask-grounded",
      "root": "C:\\…\\Temp\\okh-eval-ask-grounded-ab12cd",
      "workspace": "…\\workspace",
      "copilotHome": "…\\copilot-home",
      "backend": "local",
      "createdAt": "2026-07-03T18:00:00.000Z"
    }
  ]
}
```

Ordered array; the **last element is the most-recent** run.

API (each takes an injectable `stateFile` path, default = the tmpdir location,
so tests use an isolated file):

- `recordRun(rec: RunRecord, stateFile?)` — upsert by `scenario` (a re-`setup`
  of the same scenario replaces its entry and moves it to the end). Atomic write
  (temp file + rename), matching the repo's on-disk-state convention.
- `readRuns(stateFile?): RunRecord[]` — returns `[]` when the file is absent.
- `resolveRun(scenario: string | undefined, stateFile?): RunRecord` — returns the
  named run, or the most-recent when `scenario` is `undefined`. Throws a clear
  error when no run matches, or when the resolved `root` no longer exists on disk
  ("run was cleaned or removed — re-run `setup`").
- `forgetRun(root: string, stateFile?)` — remove the entry with that `root`.

```ts
export interface RunRecord {
  scenario: string;
  root: string;
  workspace: string;
  copilotHome: string;
  backend: EvalBackend; // "local" | "git-auto"
  createdAt: string;    // ISO
}
```

### `eval/okh-eval.ts` changes

- `SetupResult` gains `scenario: string` and `backend: EvalBackend` (additive).
  `setupScenario` stays otherwise pure and does **not** write state (keeps its
  unit tests side-effect-free). The `main` `setup` branch calls
  `recordRun(...)` after provisioning and prints frictionless next steps.

- New pure helper for testability:

  ```ts
  export function buildEnterInvocation(
    rec: RunRecord,
    model?: string,
  ): { command: string; args: string[]; cwd: string; env: Record<string, string> };
  // command "copilot", args ["--allow-all", ...(model ? ["--model", model] : [])],
  // cwd rec.workspace, env { COPILOT_HOME: rec.copilotHome }
  ```

- New `enter [scenario] [--model M]` command in `main`: `resolveRun(scenario)`,
  then spawn the invocation with `stdio: "inherit"` (interactive), reusing the
  spawn pattern already used for Copilot in `eval/copilot.ts`. Returns the child
  exit code. The spawn wrapper is thin; the pure `buildEnterInvocation` carries
  the logic under test.

- `check [scenario] [--scenario <name>]`:
  - If `--scenario` is present → **old form** `check <root> --scenario <name>`
    (backward compatible; still what `MANUAL-TESTING.md` power users may script).
  - Otherwise → resolve `{root, scenario}` from state (positional scenario name,
    or the most-recent run) and call `runChecks(root, scenario)`.
  - `runChecks(root, name)` signature is **unchanged**.

- `clean [scenario]`:
  - Arg that looks like a path (absolute, or contains a path separator, or names
    an existing directory) → **old form**: `clean(that path)`.
  - Arg that is a scenario name → `resolveRun(name)` then clean its `root`.
  - No arg → resolve the most-recent run and clean it.
  - Always `forgetRun(root)` afterward. `clean(pathOrRoot)` signature unchanged.

### Command resolution summary

| Command                     | Path source                                             |
|-----------------------------|---------------------------------------------------------|
| `setup <scenario>`          | new unique temp dir; recorded in state                  |
| `enter [scenario]`          | state (named or most-recent); launches interactive session |
| `check [scenario]`          | state (named or most-recent)                            |
| `check <root> --scenario N` | explicit path (backward compatible)                     |
| `clean [scenario]`          | state (named or most-recent)                            |
| `clean <root\|workspace>`   | explicit path (backward compatible)                     |

## Error handling

- `resolveRun` with no matching/most-recent run → actionable message telling the
  operator to run `setup` first.
- Resolved `root` missing on disk (already cleaned or temp-swept) → message to
  re-run `setup`; the stale entry can be dropped via `clean`/`forgetRun`.
- Malformed/absent state file → treated as empty (`readRuns` returns `[]`).

## Testing

New `eval-test/run-state.test.ts`:
- `recordRun` → `resolveRun(name)` and `resolveRun(undefined)` (most-recent).
- upsert semantics (re-record same scenario replaces + reorders).
- stale run (root removed) → `resolveRun` throws the clear error.
- `forgetRun` removes only the matching entry.

New coverage for `buildEnterInvocation` (own test or added to
`okh-eval.test.ts`): correct `command`, `args` (with/without `--model`), `cwd`,
and `env.COPILOT_HOME`.

Unchanged and must stay green: `eval-test/okh-eval.test.ts`,
`eval-test/provision.test.ts`, and the whole core suite.

Verification commands:
- `npm run typecheck:eval` and `npm run test:eval` (eval harness).
- `npm run typecheck` and `npm test` (core suite — must remain unaffected).

## Docs

- Rewrite `eval/MANUAL-TESTING.md` steps 2–5 to the no-copy-paste flow:
  `setup <scenario>` → `enter` → `check` → `clean` (all path-free), noting the
  explicit-path forms still work.
- Update `eval/README.md` where it points at manual mode, if wording changes.
