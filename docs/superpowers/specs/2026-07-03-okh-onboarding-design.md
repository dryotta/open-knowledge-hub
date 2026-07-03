# Design: OKH onboarding experience — preview/confirm `add`, prompt catalog, tests, e2e

Date: 2026-07-03
Status: Approved (brainstorming)

## Problem

After a user installs the OKH MCP server, the first-run journey is thin and, in
places, rough:

- `add { source }` only registers a folder that **already exists** — a
  non-existent path returns `NOT_FOUND`, so "start a brand-new hub from scratch"
  is not a smooth one-step action. The user must `mkdir` first, then `add`.
- `add` **silently scaffolds** a manifest (and `addModule` silently creates a
  folder + scaffolds content) with no confirmation, even though these are
  creative, on-disk side effects.
- The nine existing e2e scenarios **all pre-register a container**. The true
  first-time journey — empty registry → `add` a container → `add` a module →
  first `learn`/`remember` → `sync` — is completely **untested end-to-end**.
- There is no user-facing `USAGE.md` recommending prompts, and no curated list
  of the prompts OKH should support and optimize for.
- **Tool routing is unreliable for the cognitive verbs.** `ask`, `learn`,
  `remember`, `context`, `reflect` collide with normal agent behavior, so a bare
  "remember that X" is usually handled inline instead of routing to OKH. Every
  existing eval prompt already works around this by prefixing
  `"Use the open-knowledge-hub MCP tools."` There is no user-facing convention
  (a short "wake phrase") to reliably address the hub.

## Goal

Optimize the onboarding product experience and lock it in with tests + evals:

1. Let users **add an existing GitHub repo** (empty or populated), **add an
   existing folder**, or **create a brand-new local folder** — with a
   **confirmation step** before OKH creates folders or initializes a manifest.
2. Publish a **catalog of recommended prompts** (onboarding + everyday use) and a
   user-facing **`USAGE.md`** (a curated subset).
3. Add **unit tests** for the redesigned `add`, and **automated e2e scenarios**
   for the first-run journey (including cloning a **real private GitHub repo**).
4. Give users a reliable, **customizable "wake phrase"** (default `okh`) to
   address the hub, announced by the server, plus an **`onboard` flow** that
   guides first-run setup and lets the user set that phrase.

## Non-goals

- No server-side LLM or autonomous reasoning (ADR-0001 stands: deterministic
  tools + discipline text; the client agent does the thinking).
- No dependency on optional MCP client primitives for confirmation. Elicitation
  is noted as a future option only (see "Confirmation mechanism").
- **PR-mode `sync` is not automated e2e** — it needs a real GitHub remote with
  write access + `gh`. It is covered by unit tests and a manual entry.
- No real push/sync against the test GitHub repo — the clone path only.

## Confirmation mechanism (selected)

**Approach A — preview-then-confirm on `add`, agent-driven — plus tool
annotations.** Chosen over (B) MCP elicitation and (C) a separate `plan` tool.

Rationale: elicitation depends on an optional client primitive with uneven
support (ADR-0001 already avoids depending on the prompts primitive for the same
reason), and OKH's eval harness runs `copilot --allow-all`, which bypasses the
host's tool-approval UI — so host-approval alone would gate nothing in our own
tests. Approach A is deterministic, client-agnostic, testable, and mirrors the
existing `WRITE_POLICY` (the agent already confirms with the user before `sync`).
Tool **annotations** are added as the common-practice layer so well-behaved hosts
still surface a prompt.

## Section 1 — `add` redesign

### Core invariant

`add` **never creates, clones, or initializes anything on disk without an
explicit `create: true`.** Without it, `add` performs **zero side effects** and
returns a **plan** describing exactly what it would do.

### New field

`create?: boolean` on the `add` tool (and on `AddContainerInput` /
`AddModuleInput` at the service layer). Authorizes side-effectful
initialization: creating a non-existent local folder, cloning a git repo,
writing a manifest where none exists, and creating/scaffolding a module folder.

### Behavior matrix

| `add` call | `create` absent | `create: true` |
|---|---|---|
| Local path **exists + has manifest** | register (no gate — nothing is created) | same |
| Local path **exists, no manifest** | preview: "will initialize manifest" | init manifest + register |
| Local path **does not exist** | preview: "will create folder + init manifest" | `mkdir -p` + init manifest + register |
| **Git URL** (any) | preview: "will clone `<url>` → `<path>`, init manifest if empty" | clone + init-if-empty + register |
| **Module** (`container,path,type`) | preview: "will create folder `<path>` + scaffold `<type>`" | create folder + scaffold + append manifest |

The **only** zero-side-effect, single-call path is registering an
already-initialized existing hub (path exists **and** has a valid manifest).
Everything else routes through preview → user confirms → re-call with
`create: true`.

Duplicate-name and duplicate-module-path checks still fire (with or without
`create`), and can be reported at preview time so the agent doesn't ask the user
to confirm an action that would fail. `name` derivation and `sync` mode continue
to be honored when applying with `create: true`.

### Return shape

- **Preview:** `ok(...)` text beginning with a clear banner, e.g.
  `Plan (no changes made). Re-run add with create:true to apply:` followed by a
  bulleted list of concrete actions, **plus** `structuredContent`:

  ```jsonc
  {
    "plan": {
      "kind": "container" | "module",
      "actions": ["create-folder", "clone", "init-manifest", "scaffold-module"],
      "target": "/abs/path",          // folder to create / clone into / module root
      "name": "my-notes",             // container name (container plans)
      "backend": "local" | "onedrive" | "git",
      "sync": "auto" | "pr",
      "source": "…",                  // git url or path (container plans)
      "module": { "path": "kb", "type": "knowledge" } // module plans
    },
    "needsConfirmation": true
  }
  ```

- **Applied:** unchanged success text + `structuredContent: { entry }` (container)
  or `{ entry }` (module), as today.

### Service-layer changes (`src/container/service.ts`)

Split each `add*Impl` into a **pure planner** and an **applier**:

- `planAddContainer(input): AddContainerPlan` — resolves backend, name, target
  path, whether the folder exists, whether a manifest exists (for local; for git
  the "empty?" check happens after clone, so the plan states "init manifest if
  empty"), and duplicate-name detection. **No side effects.**
- `planAddModule(input): AddModulePlan` — resolves module root, duplicate-path
  detection, whether a scaffold will run. **No side effects.**
- `addContainer` / `addModule` gain the `create` field. When `create` is falsy
  **and** the plan has any side-effectful action, they return a
  `{ plan }` result (no writes). When `create` is truthy, they apply the plan
  (existing clone/mkdir/scaffold/manifest/registry logic).

Return types become a discriminated union, e.g.
`type AddContainerOutcome = { kind: "plan"; plan: AddContainerPlan } | { kind: "applied"; entry: ContainerEntry }`
(and likewise for modules). Internal helpers `loadOrScaffold` and the mkdir/clone
steps move behind the applier.

Concurrency: planning + applying still run under the existing `Mutex` when they
touch the registry, so the "plan then apply" pair stays consistent enough for our
single-agent usage. (We accept that a plan is advisory — the applier re-checks
duplicates atomically before writing.)

### Tool-layer changes (`src/server/tools.ts`)

- `inputSchema` for `add` gains `create: z.boolean().optional().describe(...)`.
- The handler maps a `{ kind: "plan" }` outcome to preview text +
  `structuredContent`, and `{ kind: "applied" }` to the current success text.
- Tool **description** gains a sentence: *"By default `add` returns a plan and
  makes no changes; show the plan to the user, get confirmation, then re-call
  with `create: true`."*
- **Annotations** (via `registerTool`'s `annotations`):
  - `inspect` → `{ readOnlyHint: true }`
  - `add` → `{ readOnlyHint: false, openWorldHint: true }` (can clone from network)
  - `sync` → `{ readOnlyHint: false, openWorldHint: true }` (push/PR)
  - `ask` / `context` / `learn` / `remember` / `reflect` → `{ readOnlyHint: true }`
    (they only return discipline text; the agent writes files and `sync` persists)

### Server instructions (`src/server/index.ts`)

Extend the `instructions` string with one onboarding sentence: how to start a hub
(from a folder, from scratch, or from a git URL) and that `add` previews changes
and needs `create: true` to apply after user confirmation. The `instructions`
also become **dynamic** to announce the configured wake phrase — see Section 6.

## Section 2 — Recommended prompt catalog

The full catalog OKH should support and optimize for. `USAGE.md` (Section 5)
publishes a curated subset; the e2e scenarios (Section 4) exercise the starred
items.

**Wake phrase convention.** Recommended prompts are addressed to the hub via its
**wake phrase** (default `okh`, user-customizable — Section 6), e.g. `"okh, …"`.
This reliably routes the request to OKH's tools, which matters most for the
cognitive verbs (`ask`/`learn`/`remember`/`context`/`reflect`) that otherwise
collide with default agent behavior. Operational verbs (`inspect`/`add`/`sync`)
usually route fine even without it.

**Onboarding / setup**

- **OB0*** "okh, help me get started" → agent invokes the `onboard` flow:
  explains OKH, `inspect`s current state, guides first-hub setup, and offers to
  set a custom wake phrase.
- **OB1** "okh, what can you do?" → agent explains OKH from server `instructions`
  + `inspect` (empty registry).
- **OB2*** "okh, set up a new knowledge hub in `./my-notes`" (folder absent) →
  `add` preview → confirm → `create:true` (create folder + init manifest).
- **OB3*** "okh, add my existing notes folder `~/notes` as a hub" (no manifest) →
  preview-init → confirm.
- **OB4** "okh, register my already-set-up hub folder" (has manifest) → `add`,
  single call, no confirmation.
- **OB5*** "okh, connect our team repo `https://github.com/org/hub.git`" →
  preview-clone → confirm → clone + register.
- **OB6** "okh, start a hub in this empty repo `<url>`" → clone + init manifest.
- **OB7** "okh, add a knowledge module `kb`" / "add a skills folder" → module
  preview → confirm.
- **OB8** "okh, show me my hubs" / "what's in `kb`?" → `inspect` (containers /
  container / module).

**Everyday use**

- **D1** "okh, remember that …" → `remember` → edit memory → confirm → `sync`.
- **D2** "okh, save/learn this: …" → `learn` (OKF) → confirm → `sync`.
- **D3** "okh, what do we know about X?" → `ask` (cited).
- **D4*** "okh, ask across all my hubs about X" → `ask` with no container filter
  (multi-container).
- **D5** "okh, prep context for task Y" → `context`.
- **D6** "okh, reflect on my memory about Z" → `reflect`.
- **D7** "okh, sync my hub" → `sync` (auto: commit + push).
- **D8** "okh, open a PR with my changes" → `sync` (pr) — **manual/unit only**.

## Section 3 — Unit tests (`test/`)

Update existing tests that assumed the old auto-scaffold / `NOT_FOUND` behavior,
and add coverage for the new invariant.

New `test/add-confirm.test.ts` (service layer) — one case per matrix cell:

- non-existent path, no `create` → outcome `kind:"plan"`; folder **not** created;
  registry **not** updated.
- non-existent path, `create:true` → folder created, manifest initialized,
  registered.
- existing path w/o manifest, no `create` → plan; manifest **not** written; not
  registered.
- existing path w/o manifest, `create:true` → manifest written, registered.
- existing path **with** manifest → registered in one call (no plan).
- git url, no `create` → plan; **nothing cloned**; not registered.
- git url (empty), `create:true` → cloned, manifest initialized, registered.
- git url (populated), `create:true` → cloned, registered, existing manifest
  untouched.
- module add, no `create` → plan; folder not created; manifest unchanged.
- module add, `create:true` → folder + scaffold created, manifest appended.
- duplicate container name / duplicate module path → error at preview and at
  apply (with and without `create`).
- `name` derivation and explicit `sync` mode honored under `create:true`.

Updates to `test/service.test.ts` / `test/inspect.test.ts`: existing "registers a
local folder in place" and "rejects a local source that does not exist" cases are
re-expressed against the new preview/confirm contract (e.g. pass `create:true`
where the test intends to actually register/create).

Tool layer `test/server.test.ts`:

- `add` without `create` returns preview text and
  `structuredContent.needsConfirmation === true`.
- `add` with `create:true` applies and returns the entry.
- registered tools carry the expected `annotations` (spot-check
  `inspect.readOnlyHint`, `add.openWorldHint`, a cognitive tool's `readOnlyHint`).

## Section 4 — E2E harness, scenarios, and the test repo

### Harness changes

`eval/provision.ts` — add provisioning modes beyond the current
`local` / `git-auto` (which pre-register a container):

- **`empty`** — an `OKH_HOME` with an **empty** registry and an empty workspace.
  Used by scenarios where the agent adds from a git URL, or creates a hub from
  scratch.
- **`unregistered-local`** — copy the fixture into the **workspace** (not into
  `containers/`, not registered). The registry stays empty; the agent must `add`
  the workspace folder itself.

`ProvisionInput`/`Provisioned` gain the mode; the `mcp-config.json` write and
isolated `COPILOT_HOME`/workspace creation are unchanged. `provision.test.ts`
gets cases for the two new modes.

`eval/okh-eval.ts` — `runChecks` currently calls `requireContainer(reg, vars.container)`,
which throws when nothing is pre-registered. Make container resolution tolerant:
for onboarding scenarios, **re-read the registry after the run** and resolve the
container the agent created (by expected `name`), or skip container-scoped checks
when the scenario declares none. `ScenarioTest.vars` gains an optional
`provision` field (`empty | unregistered-local | local | git-auto`, default
inferred from `backend` for back-compat) and an optional `container` may be the
**expected** created name.

`eval/provider/copilotProvider.ts` — honor the new `provision` var when calling
`provision(...)`; metadata already carries `okhHome`, so post-run assertions can
re-read the registry.

New assertions (`eval/assertions/`):

- **`container-registered.ts`** — re-reads the registry at `metadata.okhHome`,
  passes iff a container with the expected `name` exists with the expected
  `backend`, a **valid manifest**, and (optionally) an expected module.
- **`manifest-initialized.ts`** — passes iff `<containerPath>/.okh/okh.yaml`
  exists and parses (reuses `loadContainerManifest`).

Both are added to `SIDE_EFFECT_ASSERTIONS` in `okh-eval.ts` so manual `check`
can run them.

### New scenarios (`eval/scenarios/`)

- **`onboard-create-local`** — provision `empty`; prompt: "okh, create a new hub
  in `./my-notes` and add a knowledge module `kb`". Asserts: `add` called (≥2),
  `container-registered` (name `my-notes`, backend `local`, module `kb`),
  `manifest-initialized`, and a judge rubric: *agent presented the plan and
  confirmed before creating.*
- **`onboard-add-existing-folder`** — provision `unregistered-local` (fixture
  folder in the workspace, no manifest); prompt: "okh, add my folder `./notes` as
  a hub". Asserts `container-registered` + `manifest-initialized` + judge
  (confirmed before init).
- **`onboard-add-github`** — provision `empty`; prompt references the **real
  private repo URL** (see below): "okh, add the knowledge hub at `<url>` and tell
  me what's in it". Asserts `add` called, `container-registered` (backend `git`),
  `inspect` surfaced the repo's real modules, and a grounded `ask` answer. **No
  push/sync.**
- **`onboard-explains`** — provision `empty`; prompt: "okh, what can you do?".
  Judge rubric: agent explains containers/modules and points at `add`. (Cheap;
  text only.)
- **`onboard-wake-phrase`** — provision `empty`; prompt: "okh, help me get
  started". Asserts the `onboard` flow ran and, when the transcript shows a chosen
  phrase, that `$OKH_HOME/preferences.json` was written (new
  `wake-phrase-set.ts` assertion; passes if a non-default phrase is persisted or
  the agent clearly offered the step). Judge: agent explained the wake phrase and
  offered to customize it.
- **`ask-multi-container`** (D4) — provision two containers (extend provisioning
  to seed a second fixture, or register a second copied fixture). Prompt asks a
  question answerable only by combining both; assert grounded, cited answer that
  spans containers.

Existing scenarios (`ask-*`, `context-*`, `learn-*`, `remember-*`, `reflect-*`)
remain unchanged and green.

### Test GitHub repo

Create **private** `dryotta/okh-eval-hub` during implementation (via `gh repo
create`), pre-populated with a valid OKF hub:

```
.okh/okh.yaml           # name: okh-eval-hub, sync: auto, modules: [{path: kb, type: knowledge}]
kb/index.md             # OKF index
kb/<concept>.md         # a couple of knowledge concepts
```

Referenced only by `onboard-add-github`. Cloning a **private** repo relies on the
dev machine's `gh` credential helper (`gh auth setup-git`) — consistent with the
existing auth model in `eval/README.md` (macOS/Windows use the OS credential
store; Linux/CI needs a token with `repo` read). Documented as a prerequisite +
caveat. The repo is made public later when the project goes public.

## Section 5 — `USAGE.md`

New top-level `USAGE.md`, a curated subset of the Section 2 catalog:

- **How your prompt reaches the hub** — the agent routes to OKH based on tool
  descriptions + the server's announced **wake phrase**. Address the hub with
  `"okh, …"` (default; customizable — see below). Operational verbs
  (`inspect`/`add`/`sync`) route reliably; cognitive verbs
  (`ask`/`learn`/`remember`/`context`/`reflect`) benefit most from the prefix.
  Note the fully-deterministic alternative: clients with a prompt UI expose the
  five cognitive flows as pickable **`/`-commands**.
- **Getting started** — "okh, help me get started" (the `onboard` flow), then
  start your first hub three ways (from an existing folder, from scratch in a new
  folder, from a GitHub repo), add modules, and what the **confirmation step**
  looks like (why `add` shows a plan first, and that you say "yes" / it re-runs
  with `create`).
- **Choosing a wake phrase** — default `okh`; how to change it ("okh, call
  yourself `brain`" → `onboard { wakePhrase }`), that it takes effect on client
  restart, and the strongest option: renaming the server key in your MCP config
  to the same phrase (per-client tip).
- **Everyday use** — remember / learn / ask / context / reflect, and syncing
  (auto commit+push vs. opening a PR).

Link `USAGE.md` from `README.md` ("Typical usage" → "See USAGE.md").

## Section 6 — Onboarding prompt & wake phrase

### Wake phrase: server-announced, persisted in `$OKH_HOME`

The wake phrase is OKH-owned state, not client config (the server can't portably
edit a client's config file). Default `okh`.

- **Storage.** `$OKH_HOME/preferences.json` → `{ "wakePhrase": "okh" }`. Created
  on demand; missing/malformed file falls back to the default.
- **Config layer (`src/config.ts`).** Add `preferencesFile` to `OkhPaths` and
  `loadPreferences(paths): Preferences` / `savePreferences(paths, prefs)` (atomic
  temp-file + rename, matching the registry convention). A
  `wakePhraseSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/i)` validates it.
- **Dynamic instructions (`src/server/index.ts`).** `buildServer` reads the
  wake phrase and composes the `instructions` string to announce it:
  *"You can address this hub as `<phrase>`. When a message begins with
  `<phrase>` or mentions 'the hub' / 'knowledge hub', use these tools."* Falls
  back to `okh`. (Instructions are sent at connect time, so a phrase change
  applies on the next client restart — stated in the confirmation text.)

### The `onboard` flow (prompt + tool)

Exposed as **both** an MCP prompt and a tool, matching the existing cognitive
flows (uneven client prompt support).

- **Prompt / tool with no `wakePhrase`** → returns onboarding *discipline text*
  (new `resources/discipline/onboard.md`, vendored like the others) that guides
  the agent to: (1) briefly explain OKH (containers, typed modules, the five
  verbs, `inspect`/`add`/`sync`); (2) `inspect` to show current state; (3) help
  set up the first hub via the preview/confirm `add` (from folder / scratch /
  git URL); (4) **ask the user to pick a wake phrase** (default `okh`) and persist
  it by re-calling `onboard { wakePhrase }`; (5) point at `USAGE.md`. The
  discipline states the honest caveat that announcing via `instructions` is a soft
  hint and that renaming the client config key to the phrase is the strongest
  routing option, with per-client tips.
- **Tool with `{ wakePhrase }`** → deterministically validates and persists via
  `savePreferences`, returns a confirmation: *"Wake phrase set to `<phrase>`. It
  takes effect on the next client restart; you can already say '`<phrase>`, …'."*
  Invalid phrase → `INVALID_ARGUMENT` with a hint.
- **Annotations.** `onboard` can write preferences, so `readOnlyHint: false`.

`registerTools` wires the `onboard` tool; `registerPrompts` wires the `onboard`
prompt. Tool count goes 8 → 9; prompts 5 → 6.

### Tests (Section 3 addendum)

- `test/preferences.test.ts` — default when file absent; round-trips a custom
  phrase; rejects an invalid phrase; malformed file falls back to default.
- `test/server.test.ts` — `buildServer` `instructions` include the configured
  phrase (default and custom); `onboard` with no args returns guidance text;
  `onboard { wakePhrase }` persists + confirms; `onboard` prompt is registered.

### E2E (Section 4 addendum)

`onboard-wake-phrase` scenario (above) + new `wake-phrase-set.ts` assertion that
re-reads `$OKH_HOME/preferences.json`.

## Error handling

- Preview never mutates state; if a plan would fail (duplicate name, unknown
  container for a module), that is reported at preview time as an error result so
  the agent doesn't ask the user to confirm a doomed action.
- Git clone failures during apply keep the existing cleanup (`rm -rf` the partial
  clone) and error propagation.
- Onboarding assertions that re-read the registry treat a missing/empty registry
  as a clear failure reason ("no container was registered").

## Testing & verification

- Core: `npm run typecheck` and `npm test` (Vitest) — all green, including the
  updated `add`/tool tests.
- Eval harness: `npm run typecheck:eval` and `npm run test:eval`
  (`vitest.eval.config.ts`) — new provisioning + assertion tests green.
- Automated e2e (`npm run eval`) is **not** a required CI gate (premium-request
  cost) — run manually against the new scenarios to validate the flows.

## Docs

- `USAGE.md` (new) + `README.md` link. `README.md` "MCP surface" updated: **9
  tools** (adds `onboard`) and **6 prompts** (adds `onboard`), plus a note on the
  wake phrase and `$OKH_HOME/preferences.json`.
- `eval/README.md`: document the new provisioning modes, the `onboard-*`
  scenarios, and the private-repo clone prerequisite.
- `eval/MANUAL-TESTING.md`: add a manual **PR-mode `sync`** entry (D8) and the
  new onboarding scenarios to the manual walkthrough.

## MCP surface after this change

`inspect`, `add`, `sync`, `onboard` (operational/setup) + `ask`, `context`,
`learn`, `remember`, `reflect` (cognitive). `onboard` is exposed as both a tool
(persists a wake phrase when given one) and a prompt (guidance only). All nine
tools carry accurate annotations (Section 1).
