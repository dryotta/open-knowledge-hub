# Sync Mode and Backend Redesign

**Status:** Approved design
**Date:** 2026-07-11

## 1. Summary

Generalize synchronization behind backend adapters. Every backend supports the
universal `auto` mode. Backends may also support `shared`, with backend-specific
configuration and actions.

Git supports:

- `auto`: preserve the current direct origin sync;
- `shared`: sync through a persistent configured branch;
- `publish-pr`: sync the shared branch, then open or return its pull request to
  `main`.

The redesign also removes confirmation gates from ordinary content and todo
writes. Agents summarize changes and sync immediately. Shared-mode writes stop
after pushing the branch and tell the user how to publish the PR.

## 2. Goals and non-goals

### Goals

1. Add future backends without adding backend conditionals to
   `ContainerService`.
2. Give all backends a common `auto` mode and allow selected backends to support
   `shared`.
3. Let each backend own mode configuration, supported actions, defaults, and
   synchronization behavior.
4. Replace Git `pr` mode with persistent Git `shared` branch behavior.
5. Make `publish-pr` explicit and retry-safe.
6. Migrate existing registry entries without silently changing write safety.
7. Remove confirmation before ordinary content/todo writes and synchronization.

### Non-goals

- third-party runtime plugins or dynamically loaded backend packages;
- generalized pull-request support for non-Git providers;
- configurable Git PR base branches in this iteration;
- automatic PR publication after each shared sync;
- changing confirmation requirements for container or module setup.

## 3. Concepts

`auto` and `shared` are universal synchronization semantics:

- `auto`: synchronize through the backend's default destination and workflow;
- `shared`: synchronize through a collaborative staging destination, with
  optional publication actions.

Mode names are not backend implementation names. Git implements `shared` with a
persistent branch. A future backend may implement the same semantic mode with a
different staging mechanism and different configuration.

An action is an explicit mode-specific operation beyond default synchronization.
Actions are named strings validated by the selected backend and mode. The first
action is Git shared mode's `publish-pr`.

## 4. Persisted model

Bump the registry version from 1 to 2. Separate backend configuration from sync
configuration:

```json
{
  "version": 2,
  "containers": [
    {
      "name": "team",
      "backend": {
        "type": "git",
        "config": {
          "origin": "git@github.com:example/team.git"
        }
      },
      "localPath": "/home/me/.okh/containers/team",
      "sync": {
        "mode": "shared",
        "config": {
          "branch": "user/alice/hub"
        }
      },
      "addedAt": "2026-07-11T00:00:00Z"
    }
  ]
}
```

The registry's structural schema validates required envelope fields. The
selected backend adapter validates `backend.config`, supported sync modes, and
the selected mode's config. Unknown keys fail rather than being ignored.

Initial backend contracts are:

| Backend | Backend config | Modes | Mode config | Actions |
|---|---|---|---|---|
| `git` | `origin` | `auto`, `shared` | shared: `branch` | shared: `publish-pr` |
| `local` | none | `auto` | none | none |
| `onedrive` | none | `auto` | none | none |

Git validates `branch` as a safe branch name and rejects `main` so shared mode
cannot become a disguised direct-main workflow.

`inspect` reports the backend type, sync mode, effective mode config, and
available actions.

## 5. Backend adapter contract

Introduce a `SyncBackend` interface implemented by Git, local, and OneDrive
adapters. Exact TypeScript names may follow repository conventions, but the
contract has these responsibilities:

```ts
interface SyncBackend {
  readonly type: BackendType;
  readonly modes: readonly SyncMode[];

  validateBackendConfig(config: unknown): BackendConfig;
  resolveSyncConfig(input: unknown, context: AddContainerContext): Promise<SyncConfig>;
  actions(mode: SyncMode): readonly string[];

  sync(request: BackendSyncRequest): Promise<SyncResult>;
}
```

The adapter:

- validates backend and mode-specific configuration;
- resolves defaults during container addition or migration;
- declares actions available for a mode;
- performs default synchronization or a requested action;
- returns a common result envelope with backend-specific details.

`ContainerService`:

- resolves containers and adapters;
- performs manifest/module validation;
- requires a named container for non-default actions;
- dispatches requests to adapters;
- preserves per-container error isolation for sync-all;
- does not branch on Git modes.

Local and OneDrive may share an implementation internally while remaining
distinct registered backend types.

## 6. Tool contracts

### `add_container`

Replace the flat sync enum with a structured selection:

```ts
{
  source: string;
  name?: string;
  backend?: "local" | "onedrive";
  sync?: {
    mode: "auto" | "shared";
    config?: Record<string, unknown>;
  };
  create?: boolean;
}
```

The preview shows the effective backend, mode, and resolved config. For Git
shared mode, `config.branch` is optional. The Git adapter derives
`user/<login>/hub` from the authenticated GitHub CLI login. If login resolution
fails, addition fails and asks for an explicit branch.

Container/module setup retains the existing preview and confirmation workflow.

### `sync`

Extend the tool arguments:

```ts
{
  container?: string;
  message?: string;
  action?: string;
}
```

No action means normal synchronization. An action requires `container`; sync-all
with an action is invalid. Unsupported actions report the selected
backend/mode's available actions.

`message` remains the commit message and is also the default PR title for
`publish-pr`.

## 7. Git behavior

### 7.1 Auto mode

Preserve current behavior:

1. stage all changes;
2. commit staged changes when present;
3. `pull --ff-only` from the current branch's upstream;
4. push the current branch to `origin`.

True divergence fails and requires manual resolution.

### 7.2 Shared mode

The configured branch is persistent across sync calls. Plain sync:

1. fetch and prune `origin`;
2. ensure the configured branch is checked out:
   - use the local branch when it exists;
   - otherwise track the remote branch when it exists;
   - otherwise create it from `origin/main`;
3. stage and commit local changes when present;
4. fetch the latest remote state;
5. rebase the configured branch onto `origin/main`;
6. push the configured branch and set its upstream.

The branch is not switched back to `main`. Future edits continue on the shared
branch.

If rebase conflicts, attempt `rebase --abort`, retain the pre-rebase local
commit, and return a clear conflict error. If abort also fails, report both
errors and leave explicit recovery guidance. Push failures retain local commits
for retry.

### 7.3 `publish-pr`

`sync({ container, action: "publish-pr" })` is valid only for Git shared mode:

1. run the complete shared sync workflow;
2. query for an open PR from the configured branch to `main`;
3. return its URL when one exists;
4. otherwise create the PR and return the new URL.

This makes repeated publication calls idempotent. If branch sync succeeds but
PR lookup or creation fails, the pushed branch remains intact and a retry is
safe.

## 8. Migration

Registry migration is atomic: write version 2 only after every entry has a valid
replacement.

For each version 1 entry:

- move Git `origin` into `backend.config.origin`;
- convert `sync: "auto"` to `{ "mode": "auto", "config": {} }`;
- convert Git `sync: "pr"` to shared mode and derive
  `user/<gh-login>/hub`;
- convert non-Git `sync: "pr"` to auto because the old implementation ignored
  PR mode for those backends.

If Git login lookup fails while migrating a legacy PR container, leave the
version 1 registry untouched. Return guidance to authenticate `gh` and retry.
Migration must never silently downgrade Git PR containers to auto.

Legacy `.okh/okh.yaml` migration maps `pr` to the same shared-mode migration
path before deleting the legacy file.

## 9. Write policy

Update the shared write-policy partial and bundled workflows that repeat the old
rule, including `remember` and `todo`.

For ordinary content and todo writes:

1. choose one target container/module;
2. perform the requested local mutation without asking for confirmation;
3. inspect and summarize the resulting changes;
4. call plain `sync` immediately without waiting for user approval;
5. report the changes and sync outcome.

The deterministic todo API may retain preview support for explicit review use
cases, but normal `remember` and `todo` workflows apply directly.

For shared mode, plain sync pushes only the configured branch. The response must
say:

> Changes are on `<branch>`. When ready to publish, call `sync` with action
> `"publish-pr"`.

Do not publish automatically. Confirmation remains required for container and
module setup workflows.

## 10. Errors and results

Use a common sync result envelope with stable top-level fields:

- container name and backend type;
- mode and requested action;
- validation result;
- normalized outcome such as `synced`, `up-to-date`, `published`, `validated`,
  or `error`;
- optional backend details such as branch, commit/push state, and PR URL.

Backend-specific failures retain existing `OkhError` mapping. Do not convert
unsupported modes/actions, migration failures, rebase conflicts, or PR failures
into success-shaped results.

Named sync failures remain tool errors. Sync-all continues after an individual
container fails and includes that container's error result.

## 11. Testing

Add focused coverage for:

1. adapter registration and capability validation;
2. rejection of unsupported modes, config keys, and actions;
3. registry v1-to-v2 migration, including legacy PR safety;
4. Git shared branch defaulting and explicit branch fallback;
5. local branch creation, remote tracking, repeated sync, and current-branch
   behavior;
6. rebase onto `origin/main`, conflict abort, and recovery errors;
7. shared branch push retry behavior;
8. `publish-pr` sync-first behavior, existing PR reuse, and PR creation;
9. the named-container requirement for actions;
10. sync-all per-container isolation;
11. add/sync tool schemas, metadata, inspect formatting, and result formatting;
12. write-policy, remember, and todo prompt text;
13. unchanged Git auto and local/OneDrive auto behavior.

Run targeted tests during implementation. When development is complete and the
change is ready for PR, run the repository's full validation suite, including
the end-to-end eval.
