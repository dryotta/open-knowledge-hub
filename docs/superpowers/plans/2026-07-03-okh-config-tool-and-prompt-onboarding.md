# Generic `config` tool + prompt-based multi-turn onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dual-purpose `onboard` tool with a generic `config` tool (list + set), and turn onboarding into prompt-based, multi-turn guidance (intro → wake phrase → first repo + modules), keeping `onboard` as a thin prompt+tool.

**Architecture:** Config stays in `$OKH_HOME/preferences.json`, accessed via `src/preferences.ts`. A new `config` tool reads/merges/validates against the existing `preferencesSchema` (`.strict()`) so new settings need no signature change. The `onboard` tool becomes a thin, side-effect-free wrapper that returns the restructured `resources/discipline/onboard.md` guidance; wake-phrase changes now route through `config`.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/sdk`, `zod`, `vitest`. Evals run via `copilot` CLI + promptfoo.

Design spec: `docs/superpowers/specs/2026-07-03-okh-config-tool-and-prompt-onboarding-design.md`

---

## File Structure

- Modify `src/preferences.ts` — add `configFieldMeta`, `configKeys`; keep it the single source of truth for config shape/validation.
- Modify `src/server/tools.ts` — remove old `onboard` tool; add `config` tool; add thin `onboard` tool.
- Modify `resources/discipline/onboard.md` — rewrite into 3 stages with a multi-turn preamble.
- Modify `src/server/index.ts` — update `buildInstructions` to mention `config`.
- Modify `README.md`, `USAGE.md` — docs for `config` + wake-phrase change.
- Modify `test/preferences.test.ts`, `test/server.test.ts`, `test/prompts.test.ts` — tests.
- Modify `eval/copilot.ts`, `eval/scenarios/onboard-wake-phrase/test.yaml` — eval wiring.

`src/prompts/index.ts` `buildOnboard(...)` needs **no code change** — the wake-phrase-change wording lives in `onboard.md`, which Task 4 rewrites.

---

## Task 1: Extend `preferences.ts` with config metadata

**Files:**
- Modify: `src/preferences.ts`
- Test: `test/preferences.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/preferences.test.ts` — first extend the import on lines 3-8 to include the new exports:

```ts
import {
  loadPreferences,
  loadPreferencesSync,
  savePreferences,
  DEFAULT_WAKE_PHRASE,
  configFieldMeta,
  configKeys,
} from "../src/preferences.js";
```

Then add this test inside the `describe("preferences", () => {` block (after the last `it`):

```ts
  it("exposes config metadata keys aligned with the schema", () => {
    expect(configKeys).toContain("wakePhrase");
    const wake = configFieldMeta.find((f) => f.key === "wakePhrase");
    expect(wake).toBeDefined();
    expect(wake!.description.length).toBeGreaterThan(0);
    // every advertised key must have a description entry
    expect(configFieldMeta.map((f) => f.key)).toEqual(configKeys);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/preferences.test.ts`
Expected: FAIL — `configFieldMeta`/`configKeys` are not exported (import/compile error).

- [ ] **Step 3: Add the metadata to `src/preferences.ts`**

Insert immediately after the `preferencesSchema` / `Preferences` block (after line 19):

```ts
/** Human-facing metadata for each configurable key. Keep in sync with preferencesSchema. */
export const configFieldMeta: ReadonlyArray<{ key: string; description: string }> = [
  {
    key: "wakePhrase",
    description:
      'Short phrase used to address the hub (1-32 chars: a letter then letters, digits or dashes; default "hub"). Takes effect on the next client restart.',
  },
];

/** The list of known/valid config keys, derived from configFieldMeta. */
export const configKeys: string[] = configFieldMeta.map((f) => f.key);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/preferences.test.ts`
Expected: PASS (all preferences tests green).

- [ ] **Step 5: Commit**

```bash
git add src/preferences.ts test/preferences.test.ts
git commit -m "feat: add config field metadata to preferences" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Add the `config` tool and thin `onboard` tool

**Files:**
- Modify: `src/server/tools.ts` (imports; remove old `onboard` tool at lines 227-257; add `config` + thin `onboard`)
- Test: `test/server.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/server.test.ts`, update the tool-count assertion (line 73) to include `config`:

```ts
    expect(tools).toEqual(["add", "ask", "config", "context", "inspect", "learn", "onboard", "reflect", "remember", "sync"]);
```

Update the count wording in the `it(...)` title on line 70 to:

```ts
  it("exposes exactly the 10 tools and 6 prompts", async () => {
```

Replace the existing onboard test (lines 79-94, the `it("onboard returns guidance without args and persists a wake phrase with args", ...)` block) with these two tests:

```ts
  it("onboard returns multi-turn guidance without args and does not mutate config", async () => {
    const { client, home } = await connect();
    const guide = await client.callTool({ name: "onboard", arguments: {} });
    expect(textOf(guide)).toContain("OKH: onboard");
    expect(textOf(guide)).toContain("hub"); // default wake phrase injected

    const { loadPreferences } = await import("../src/preferences.js");
    // onboard has no wakePhrase arg anymore; prefs remain default.
    expect((await loadPreferences(makePaths(home))).wakePhrase).toBe("hub");
  });

  it("config lists settings and persists changes via set", async () => {
    const { client, home } = await connect();

    const list = await client.callTool({ name: "config", arguments: {} });
    expect(textOf(list)).toContain("wakePhrase");
    expect(textOf(list)).toContain("hub");

    const set = await client.callTool({ name: "config", arguments: { set: { wakePhrase: "brain" } } });
    expect(textOf(set)).toContain("brain");

    const { loadPreferences } = await import("../src/preferences.js");
    expect((await loadPreferences(makePaths(home))).wakePhrase).toBe("brain");

    const badValue = await client.callTool({ name: "config", arguments: { set: { wakePhrase: "no spaces" } } });
    expect(isErrorResult(badValue)).toBe(true);

    const badKey = await client.callTool({ name: "config", arguments: { set: { nope: "x" } } });
    expect(isErrorResult(badKey)).toBe(true);
    expect(textOf(badKey)).toContain("wakePhrase"); // error lists valid keys

    const empty = await client.callTool({ name: "config", arguments: { set: {} } });
    expect(isErrorResult(empty)).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL — no `config` tool registered; tool list has 9 not 10.

- [ ] **Step 3: Update imports in `src/server/tools.ts`**

Replace the preferences import (line 14):

```ts
import { loadPreferences, savePreferences, wakePhraseSchema } from "../preferences.js";
```

with:

```ts
import {
  configFieldMeta,
  configKeys,
  loadPreferences,
  preferencesSchema,
  savePreferences,
  type Preferences,
} from "../preferences.js";
```

- [ ] **Step 4: Add config formatting + error helpers**

In `src/server/tools.ts`, add these helpers just after `formatSync(...)` (after line 105):

```ts
function formatConfig(prefs: Preferences, paths: OkhPaths): string {
  const lines = [`Config (${paths.preferencesFile}):`];
  for (const { key, description } of configFieldMeta) {
    const value = (prefs as Record<string, unknown>)[key];
    lines.push(`- ${key}: ${JSON.stringify(value)} — ${description}`);
  }
  return lines.join("\n");
}

function describeConfigError(err: z.ZodError): string {
  for (const issue of err.issues) {
    if (issue.code === "unrecognized_keys") {
      return `Unknown config key(s): ${issue.keys.join(", ")}. Valid keys: ${configKeys.join(", ")}.`;
    }
  }
  const first = err.issues[0];
  const key = first?.path.join(".") || "config";
  return `Invalid value for "${key}": ${first?.message ?? "invalid value"}. Valid keys: ${configKeys.join(", ")}.`;
}
```

- [ ] **Step 5: Replace the old `onboard` tool with `config` + thin `onboard`**

In `src/server/tools.ts`, delete the entire existing `onboard` tool registration (lines 227-257, the `server.registerTool("onboard", { title: "Onboard / set wake phrase", ... })` block ending with its closing `);`) and replace it with:

```ts
  server.registerTool(
    "config",
    {
      title: "View or change configuration",
      description:
        "View or change OKH configuration (stored in preferences.json). Call with no args to list current " +
        "settings; pass { set: { <key>: <value> } } to change one or more. Known keys: " +
        `${configKeys.join(", ")}.`,
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        set: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Config keys to set, e.g. { wakePhrase: "brain" }. Omit to list current config.'),
      },
    },
    handler(async (args: { set?: Record<string, unknown> }) => {
      if (args.set === undefined) {
        const prefs = await loadPreferences(paths);
        return ok(formatConfig(prefs, paths), { preferences: prefs, keys: configKeys });
      }
      if (Object.keys(args.set).length === 0) {
        return fail("config { set } must include at least one key.", `Valid keys: ${configKeys.join(", ")}.`);
      }
      const current = await loadPreferences(paths);
      const parsed = preferencesSchema.safeParse({ ...current, ...args.set });
      if (!parsed.success) return fail(describeConfigError(parsed.error));
      await savePreferences(paths, parsed.data);
      const changed = Object.keys(args.set);
      const restartNote = changed.includes("wakePhrase")
        ? ` The wake phrase takes effect on the next client restart; you can already say "${parsed.data.wakePhrase}, …".`
        : "";
      return ok(`Updated ${changed.join(", ")}.${restartNote}\n\n${formatConfig(parsed.data, paths)}`, {
        preferences: parsed.data,
        changed,
      });
    }),
  );

  server.registerTool(
    "onboard",
    {
      title: "Onboard (guided setup)",
      description:
        "Return multi-turn onboarding guidance (intro, wake phrase, first repo + modules) for a first-run user. " +
        "Set the wake phrase via the config tool.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    handler(async () => {
      const { wakePhrase } = await loadPreferences(paths);
      const targets = await service.resolveTargets();
      return ok(await buildOnboard(targets, wakePhrase));
    }),
  );
```

The thin `onboard` is side-effect-free (like `ask`/`context`/etc.), so it is
`readOnlyHint: true`. Update the annotations test accordingly: change the existing
`expect(byName.onboard!.readOnlyHint).toBe(false);` assertion to
`expect(byName.onboard!.readOnlyHint).toBe(true);` (keep `openWorldHint` false).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/server.test.ts`
Expected: PASS. (The annotations test now asserts `onboard` `readOnlyHint:true`, `openWorldHint:false`.)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 (no unused `wakePhraseSchema` import, `z.ZodError` narrowing compiles).

- [ ] **Step 8: Commit**

```bash
git add src/server/tools.ts test/server.test.ts
git commit -m "feat: replace onboard tool with generic config tool + thin onboard" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Rewrite the onboarding discipline into 3 stages

**Files:**
- Modify: `resources/discipline/onboard.md` (full replace)
- Test: `test/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/prompts.test.ts`, add this test inside the `describe("discipline loader", () => {` block (after the existing `it(...)` cases):

```ts
  it("onboard discipline is staged and routes wake-phrase changes to config", async () => {
    const text = await loadDiscipline("onboard");
    expect(text).toMatch(/Stage 1/);
    expect(text).toMatch(/Stage 2/);
    expect(text).toMatch(/Stage 3/);
    expect(text).toContain("config { set: { wakePhrase");
    expect(text).not.toContain("onboard { wakePhrase");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/prompts.test.ts`
Expected: FAIL — current `onboard.md` has no `Stage 1` and still references `onboard { wakePhrase`.

- [ ] **Step 3: Replace `resources/discipline/onboard.md` with the staged version**

Replace the entire file contents with:

```markdown
# Onboarding a new user

You are guiding someone who just installed Open Knowledge Hub (OKH). Keep it
brief and concrete, and run onboarding as a **multi-turn conversation**: do ONE
stage per turn, check in with the user, and only then move on. If the user
returns partway through, resume at the first unfinished stage. The current wake
phrase and registered hubs are injected above — use them.

## Stage 1 — Intro

Explain OKH in two sentences: it organizes knowledge and capabilities into
*containers* (a local folder, an OS-synced folder, or a git repo) made of typed
*modules* (`knowledge`, `skills`, `tools`, `memory`, `project`). You do the
thinking; OKH stores, validates, and syncs.

Then show current state from the hub list above. If none are registered, say so.
Ask whether they'd like to (a) choose a wake phrase or (b) set up their first
hub, and continue with the matching stage.

## Stage 2 — Wake phrase

Tell the user they can address the hub by a short *wake phrase* (shown above;
default `hub`). Naming the hub makes requests route reliably to these tools —
especially `ask`, `learn`, `remember`, `context`, `reflect`, which otherwise look
like ordinary requests.

If they want a different phrase, persist it with the `config` tool:
`config { set: { wakePhrase: "<their choice>" } }`. It takes effect on the next
client restart; they can already use it immediately. For the most reliable
routing, they can also rename this server's key in their MCP client config to the
same phrase (client-specific; offer to help).

## Stage 3 — First repo and modules

Offer to set up the first hub. Ask which the user wants:
- an existing folder they already have,
- a brand-new folder to create from scratch,
- a git repository (GitHub) to clone.

Then call `add`. Remember: `add` returns a *plan* and makes no changes by
default. Show the plan to the user, get an explicit "yes", then call `add` again
with `create: true`. After a container exists, offer to add a `knowledge` module
(and others as needed) the same way.

## Wrap up

Once set up, point at everyday use: they can say things like
"<wake phrase>, remember that …", "<wake phrase>, what do we know about …?", and
"<wake phrase>, sync my hub". See USAGE.md for the full list.

Never create folders, initialize manifests, or sync without explicit confirmation.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add resources/discipline/onboard.md test/prompts.test.ts
git commit -m "feat: restructure onboarding discipline into 3 multi-turn stages" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Update server instructions

**Files:**
- Modify: `src/server/index.ts` (`buildInstructions`, lines 13-22)
- Test: `test/server.test.ts` (existing instructions test at lines ~96-113 stays green; add a `config` check)

- [ ] **Step 1: Add an assertion to the instructions test**

In `test/server.test.ts`, find the `it("announces the configured wake phrase in server instructions", ...)` test (around line 96). It reads the server instructions into a variable and asserts on the wake phrase. Locate the existing `expect(...)` that checks the instructions string and add, immediately after it, an assertion that the instructions mention `config`. If the instructions string is captured as `instructions`, add:

```ts
    expect(instructions).toContain("config");
```

(If the local variable has a different name in that test, use that name — it is the string passed to / read from the built server's instructions.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL on the new `toContain("config")` assertion — current instructions do not mention `config`.

- [ ] **Step 3: Update `buildInstructions` in `src/server/index.ts`**

Replace the current body (lines 14-21) with:

```ts
  return (
    "Open Knowledge Hub: organizes agent knowledge and capabilities into containers of typed modules " +
    "(knowledge, skills, tools, memory, project). Use inspect/add/sync to manage containers and config to " +
    "view or change settings; use ask/context/learn/remember/reflect (prompts or tools) to think with them. " +
    "Start with the onboard prompt/tool for first-run setup. `add` previews changes and needs create:true to " +
    "apply after user confirmation. " +
    `You can address this hub as "${wakePhrase}": when a message begins with "${wakePhrase}" or mentions ` +
    '"the hub" / "knowledge hub", use these tools. Writes are synced via git (commit+push, or pull requests).'
  );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts test/server.test.ts
git commit -m "feat: mention config tool in server instructions" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Update user-facing docs

**Files:**
- Modify: `README.md` (lines 38, 45, 52-nearby, 88-93)
- Modify: `USAGE.md` (lines 37-42)

No tests (docs). Verify by reading the diff.

- [ ] **Step 1: Update the README tools section**

In `README.md`, change the heading on line 38 from `**Tools (9)**` to `**Tools (10)**`.

Replace the `onboard` table row (line 45):

```markdown
| `onboard` | `wakePhrase?` | Guide first-run setup; persist a custom wake phrase. |
```

with these two rows:

```markdown
| `onboard` | _(none)_ | Guide multi-turn first-run setup (intro, wake phrase, first repo + modules). |
| `config` | `set?` | View configuration (no args) or change it, e.g. `{ set: { wakePhrase: "brain" } }`. |
```

- [ ] **Step 2: Update the README wake-phrase section**

Replace lines 90-93:

```markdown
Address the hub by its wake phrase (default `hub`), e.g. `hub, remember that …`.
Change it with the `onboard` tool; OKH stores it in `$OKH_HOME/preferences.json`
and announces it in the server instructions. See **[USAGE.md](./USAGE.md)** for
recommended prompts.
```

with:

```markdown
Address the hub by its wake phrase (default `hub`), e.g. `hub, remember that …`.
Change it with the `config` tool (`config { set: { wakePhrase: "brain" } }`); OKH
stores it in `$OKH_HOME/preferences.json` and announces it in the server
instructions. See **[USAGE.md](./USAGE.md)** for recommended prompts.
```

- [ ] **Step 3: Update USAGE.md wake-phrase section**

In `USAGE.md`, replace lines 39-42:

```markdown
The default is `hub`. To change it: `hub, call yourself brain.` — your agent
persists it via the `onboard` tool. It takes effect the next time your MCP client
restarts. For the most reliable routing, you can also rename this server's key in
your MCP client config to the same phrase (client-specific).
```

with:

```markdown
The default is `hub`. To change it: `hub, call yourself brain.` — your agent
persists it via the `config` tool (`config { set: { wakePhrase: "brain" } }`). It
takes effect the next time your MCP client restarts. For the most reliable
routing, you can also rename this server's key in your MCP client config to the
same phrase (client-specific).
```

- [ ] **Step 4: Commit**

```bash
git add README.md USAGE.md
git commit -m "docs: document config tool and config-based wake phrase" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Update eval harness + onboard-wake-phrase scenario

**Files:**
- Modify: `eval/copilot.ts` (line 46, `OKH_TOOLS`)
- Modify: `eval/scenarios/onboard-wake-phrase/test.yaml`

- [ ] **Step 1: Add `config` to the recognized OKH tools**

In `eval/copilot.ts`, replace line 46:

```ts
const OKH_TOOLS = ["inspect", "add", "sync", "onboard", "ask", "context", "learn", "remember", "reflect"] as const;
```

with:

```ts
const OKH_TOOLS = ["inspect", "add", "sync", "onboard", "config", "ask", "context", "learn", "remember", "reflect"] as const;
```

- [ ] **Step 2: Update the onboard-wake-phrase scenario**

Replace the entire contents of `eval/scenarios/onboard-wake-phrase/test.yaml` with:

```yaml
- vars:
    scenario: onboard-wake-phrase
    backend: local
    provision: empty
    container: hub
    fixture: fixtures/plain-notes
    prompt: |
      hub, help me get started. I'd like to call you "brain" from now on.
  assert:
    - type: javascript
      value: file://assertions/tools-called.ts
      config: { expect: [config] }
    - type: javascript
      value: file://assertions/wake-phrase-set.ts
      config: { default: hub }
    - type: javascript
      value: file://assertions/judge.ts
      config:
        criteria:
          - id: explained-onboarding
            text: The agent explained getting started / onboarding.
          - id: set-wake-phrase
            text: The agent set the wake phrase to "brain".
            check: { kind: wake-phrase, default: hub }
          - id: used-config
            text: The agent used the config tool to set the wake phrase.
            check: { kind: tool, name: config }
```

- [ ] **Step 3: Typecheck + validate the eval config**

Run: `npm run typecheck:eval`
Expected: exit 0.

Run: `npm run eval:validate`
Expected: prints `Configuration is valid.`

- [ ] **Step 4: Run eval unit tests**

Run: `npm run test:eval`
Expected: PASS (no live-model calls; harness unit tests green).

- [ ] **Step 5: Commit**

```bash
git add eval/copilot.ts eval/scenarios/onboard-wake-phrase/test.yaml
git commit -m "test: update evals for config tool and staged onboarding" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Core typecheck + tests + build**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm test`
Expected: all tests pass (server, preferences, prompts, and the rest).

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 2: Eval checks**

Run: `npm run typecheck:eval`
Expected: exit 0.

Run: `npm run eval:validate`
Expected: `Configuration is valid.`

Run: `npm run test:eval`
Expected: all eval unit tests pass.

- [ ] **Step 3: Full end-to-end eval (larger-change gate)**

Run: `npm run eval`
Expected: the `onboard-wake-phrase` scenario passes with the agent calling `config` to set the wake phrase and explaining onboarding; the other `onboard-*` scenarios still pass. Investigate and fix any regressions before declaring done.

- [ ] **Step 4: Final commit (if verification produced fixes)**

```bash
git add -A
git commit -m "chore: verification fixes for config tool + onboarding" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review notes

- **Spec coverage:** §1 config tool → Task 1-2; §2 staged onboarding → Task 3; §3 wiring → Task 2 (thin onboard) + Task 4 (instructions); §4 docs → Task 5; §5 tests+evals → Tasks 2/3/6 and full verification in Task 7 (including `npm run eval`).
- **Type consistency:** `configFieldMeta`/`configKeys` defined in Task 1 and imported in Task 2; `describeConfigError` uses zod v3 `unrecognized_keys` issue `keys`; `formatConfig(prefs: Preferences, paths: OkhPaths)` uses types already imported in `tools.ts`.
- **No placeholders:** every code/edit step shows the exact content.
