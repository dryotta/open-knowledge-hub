# Design: One-command manual testing environment

## Goal

Replace the multi-step manual eval workflow with one command:

```powershell
npm run manual
```

The command creates an isolated temporary environment, opens an interactive
Copilot CLI session, and removes the environment when the session ends.

## Command

```powershell
npm run manual -- [env] [--model <model>]
```

- `env` is optional and defaults to `local-and-git`.
- Valid environment names remain defined by `eval/environments.ts`.
- `--model` is optional and passes the selected model to Copilot CLI.
- Unknown environments, missing option values, and unexpected arguments fail
  before provisioning with concise usage guidance.

## Lifecycle

`eval/manual.ts` owns the complete manual session:

1. Parse and validate arguments.
2. Provision the selected environment with `provisionEnvironment`.
3. Load and print the environment's scenario prompts and checklists.
4. Print the temporary OKH home, Copilot home, and workspace paths.
5. Launch `copilot --allow-all` in the temporary workspace with the isolated
   `COPILOT_HOME`.
6. Remove the full temporary root in a `finally` block.
7. Return the Copilot process exit code, or a non-zero code when provisioning
   or launch fails.

Cleanup applies after normal exit, Copilot failure, launch errors, and
interrupt-driven child termination. No persistent run-state file or follow-up
cleanup command is needed.

## Code structure

- Add `eval/manual.ts` as the one-shot manual entry point.
- Reuse `eval/environments.ts` for environment definitions and provisioning.
- Keep scenario discovery and prompt/checklist formatting with the manual
  entry point because automated promptfoo execution does not depend on it.
- Remove `eval/okh-eval.ts` and `eval/run-state.ts`.
- Remove `eval-test/run-state.test.ts`.
- Replace `eval-test/okh-eval.test.ts` with focused tests for the manual module.

## npm scripts

Add:

```json
"manual": "tsx eval/manual.ts"
```

Remove:

```json
"eval:setup": "tsx eval/okh-eval.ts"
```

Keep the automated eval commands:

- `eval`
- `eval:validate`
- `eval:view`
- `typecheck:eval`
- `test:eval`

The removed `list`, `setup`, `enter`, and `clean` operations only supported the
old manual workflow and have no automated eval callers.

## Documentation

Update `eval/README.md` to describe the one-command workflow, default
environment, optional environment/model arguments, printed prompts, and
automatic cleanup. Remove references to recorded runs and manual subcommands.

Historical design and plan documents remain unchanged.

## Testing

Focused tests cover:

- default environment selection;
- explicit environment selection;
- optional model forwarding;
- scenario grouping and prompt/checklist loading;
- isolated Copilot invocation;
- cleanup after successful and failed child execution;
- invalid arguments failing before provisioning.

Validate with the existing eval typecheck, eval tests, eval configuration
validation, server build, and server typecheck. The live Copilot session is a
manual smoke check after implementation is otherwise complete.
