# OKH eval: multi-turn conversations (Copilot CLI)

Date: 2026-07-05
Status: Approved (design)

## Problem

The e2e eval provider runs each scenario as a **single** `copilot -p "<prompt>"` call and
grades the one-shot transcript. Flows like **onboard** are inherently **multi-turn**: the
`onboard` discipline runs a staged conversation (name the hub → concepts + first container →
everyday use), doing one stage per turn and checking in with the user between stages. Today's
scenarios fake this by stuffing hints into a single prompt ("when you ask, assume I say yes"),
so the genuine multistep behaviour — pausing for a wake phrase, previewing an `add` plan and
waiting for confirmation, then wrapping up — is never actually exercised.

We want the provider to **drive a real multi-turn conversation** through the Copilot CLI (no
LLM API keys), responding to the agent at each stage, and to verify the staged behaviour.

## Research findings (empirically verified against Copilot CLI 1.0.69-1)

- **Session continuity across `-p` calls.** `copilot -p <msg> --session-id <uuid>` creates a
  session with our supplied UUID; a later `copilot -p <msg2> --resume=<uuid>` continues the
  **same conversation** (verified: turn 2 recalled a number from turn 1). `result.sessionId`
  equals the UUID we passed.
- **`ask_user` does not hang in `-p` mode.** When the agent wants user input it ends its turn
  gracefully with a text question (exit 0), rather than blocking on `ask_user`. This is
  exactly what a resume-based driver needs: one `-p` invocation == one conversational turn.
- **Structured output.** `--output-format json` emits JSONL, one event per line. Relevant
  events: `assistant.message` (`data.content`, `data.toolRequests[]`), `tool.execution_start`
  (`data.mcpServerName`, `data.mcpToolName`), and a final `result` (`sessionId`, `exitCode`,
  `usage.premiumRequests`). MCP tool calls carry `mcpServerName: "open-knowledge-hub"` +
  `mcpToolName: "<tool>"` — a robust signal, replacing the fragile text-regex extractor.
- **Cost is cumulative** per session: `result.usage.premiumRequests` grows across turns, so
  the **last turn's** value is the whole-conversation cost.
- **Provisioning is unchanged.** The eval writes the OKH MCP config into `COPILOT_HOME`, so a
  spawned `copilot` auto-loads the server; no `--additional-mcp-config` needed.

## Decision

Evolve the provider from a single call into a **guarded conversation driver** over session
resume, reading each turn via `--output-format json`. Scenarios stay one-element scenario
lists; a new optional `vars.turns` list supplies guarded follow-up messages. Scenarios with no
`turns` run exactly one turn — **fully backward compatible** with the 16 existing cases.

## Design

### 1. Data flow

```
CopilotProvider.callApi(prompt, {vars})
  ├─ provisionEnvironment(env)                       (unchanged)
  ├─ script = { initial: prompt, responses: vars.turns ?? [], maxTurns }
  └─ runConversation(script, { runner, model, copilotHome, cwd, timeoutMs })
        turn 1:  copilot -p <initial> --session-id <uuid> --allow-all --output-format json [--model M]
        loop:    pick next response (guard match) → copilot -p <msg> --resume=<uuid> ...
                 stop when no eligible response OR turn count reaches maxTurns
  → { output: aggregated transcript,
      metadata: { toolCalls, turns[], cost, exitCode, workspace, okhHome, containerPath, fixtureDir, originPath } }
```

### 2. `eval/copilot.ts`

- **`parseCopilotEvents(jsonl): ParsedTurn`** where
  `ParsedTurn = { messages: string[]; lastMessage: string; tools: string[]; cost: number; sessionId: string | null; code: number | null }`.
  Iterates JSONL lines (ignoring non-JSON / ephemeral noise); collects `assistant.message`
  contents, OKH tool names from both `assistant.message.data.toolRequests[]` and
  `tool.execution_start.data` (where `mcpServerName === "open-knowledge-hub"` → `mcpToolName`),
  and the `result` event's `sessionId`/`exitCode`/`usage.premiumRequests`. Replaces the
  text-regex `extractToolCalls`.
- **`spawnCopilotTurn: CopilotTurnRunner`** — spawns one turn:
  `-p <prompt> --allow-all --output-format json` plus `--session-id <uuid>` (turn 1) or
  `--resume=<uuid>` (later turns), `[--model M]`; captures stdout+stderr, per-turn timeout
  (SIGKILL), returns `parseCopilotEvents(raw)` augmented with the raw JSONL. Injectable.

  ```ts
  interface CopilotTurnOptions {
    prompt: string; sessionId: string; resume: boolean;
    model?: string; copilotHome: string; cwd: string; timeoutMs?: number;
    extraEnv?: NodeJS.ProcessEnv;
  }
  interface CopilotTurnResult extends ParsedTurn { raw: string }
  type CopilotTurnRunner = (opts: CopilotTurnOptions) => Promise<CopilotTurnResult>;
  ```

- **`runConversation(script, ctx): Promise<ConversationResult>`** — the driver.

  ```ts
  interface Turn { send: string; when?: string }               // when = regex vs agent's last message
  interface ConversationScript { initial: string; responses: Turn[]; maxTurns?: number }
  interface ConversationResult {
    transcript: string;                                        // aggregated, human-readable (for judge + transcript asserts)
    toolCalls: string[];                                       // union of OKH tools across turns, sorted
    turns: { user: string; agent: string; tools: string[] }[];
    cost: number;                                              // last turn's cumulative premiumRequests
    code: number | null;                                       // last turn's exit code
  }
  ```

  Algorithm:
  1. `uuid = randomUUID()`; run turn 1 with `initial` (`resume: false`). Record.
  2. Loop until stop:
     - **Select** the next user message from unsent `responses`: the first whose `when` is
       present **and** matches the agent's last message; else the first with **no** `when`
       (ordered fallback); else `null` → stop.
     - Stop if `turnsRun >= maxTurns` (default `responses.length + 2`).
     - Run the turn (`resume: true`) with the chosen message; record; mark it sent.
  3. If any turn returns a non-zero/`null` exit code, record the turn and stop.
  4. Aggregate the transcript as labelled `USER (turn i)` / `AGENT (turn i)` blocks so the
     judge grades the whole conversation and `transcript`/`transcript-contains` asserts still
     work.

- `spawnCopilot` (text single-shot) and `CopilotRunner` are **unchanged** — the judge
  (`eval/judge.ts`) keeps using them for grading.

### 3. `eval/provider/copilotProvider.ts`

- Read `context.vars.turns` (optional). Each entry is either a string (unguarded) or
  `{ send: string, when?: string }`; normalise to `Turn[]`.
- Build `script = { initial: prompt, responses, maxTurns: config.maxTurns }`.
- Call `runConversation` with `runner = config.runner ?? spawnCopilotTurn`, the provisioned
  `copilotHome`/`workspace`, `model`, and `timeoutMs`.
- Return `{ output: result.transcript, metadata: { …existing…, toolCalls: result.toolCalls,
  turns: result.turns, cost: result.cost, exitCode: result.code } }`.
- No `turns` → `responses: []` → one turn → identical to today's behaviour.

`eval/scenarios/shared/provider.ts` is unchanged (still forwards `config`); the default
`maxTurns` lives in `runConversation`.

### 4. Flagship scenario — `eval/scenarios/onboard/cold-start-conversation.yaml`

Env `empty`. Drives the full onboarding conversation with guarded turns:

```yaml
- config:
    - vars:
        env: empty
        prompt: "Use the Open Knowledge Hub MCP and run onboard to set me up."
        turns:
          - when: "wake phrase|name|call it|address|what.*call"
            send: "Let's call it 'brain'."
          - when: "existing|new folder|git|repository|which|container|set up"
            send: "Create a brand-new folder called 'my-notes' with a knowledge module named 'kb'."
          - when: "plan|confirm|proceed|go ahead|create|shall i|ready"
            send: "Yes, go ahead and create it."
          - send: "Thanks — how would I use it day to day?"
  tests:
    - description: Onboard - cold-start conversation - staged multi-turn setup
      assert:
        - { type: javascript, value: file://assertions/tools-called.ts, config: { expect: [onboard, config, add] } }
        - { type: javascript, value: file://assertions/wake-phrase-set.ts }
        - { type: javascript, value: file://assertions/container-registered.ts, config: { name: my-notes, backend: local, module: kb } }
        - { type: javascript, value: file://assertions/manifest-initialized.ts, config: { name: my-notes } }
        - type: javascript
          value: file://assertions/judge.ts
          config:
            criteria:
              - { id: ran-onboard, text: "The agent ran the onboard flow to begin guided setup.", check: { kind: tool, name: onboard } }
              - { id: asked-wake-phrase, text: "Early on, the agent explained OKH briefly and asked the user to choose a wake phrase before doing setup." }
              - { id: set-wake-phrase, text: "The agent saved the user's chosen wake phrase via config.", check: { kind: wake-phrase } }
              - { id: previewed-before-create, text: "The agent showed/echoed the add plan and waited for a yes before creating anything." }
              - { id: created-hub-kb, text: "A container 'my-notes' with a 'kb' knowledge module was created.", check: { kind: container, name: my-notes, backend: local, module: kb } }
              - { id: showed-everyday-use, text: "The agent closed by showing how to use the hub day to day (e.g. remember/learn/ask examples)." }
```

The existing single-turn `cold-start-phrase.yaml` stays (cheap routing smoke); this new file
is the deep multistep test.

### 5. Testing

- **`eval-test/copilot.test.ts`** (rewrite): `parseCopilotEvents` extracts tools from
  `toolRequests[]` and `tool.execution_start`, keyed on `mcpServerName`; pulls
  messages/cost/sessionId/exitCode; ignores non-OKH servers and non-JSON lines.
  `runConversation` guard logic with a **fake `CopilotTurnRunner`**: guard match wins over
  ordered fallback; adapts when the agent reorders stages; unguarded ordered fallback;
  `maxTurns` cap; stop when responses exhausted; aggregated transcript + union tool list.
- **`eval-test/provider.test.ts`** (update): fakes migrate to the turn-runner shape; add a
  multi-turn case asserting turns are sent in guarded order and `toolCalls`/transcript
  aggregate; keep single-turn + empty-env cases.
- Harness verification: `npm run typecheck:eval`, `npm run test:eval`, `npm run eval:validate`.
- Live gate (larger-change rule): `npm run build` then a live run of the new scenario via
  `--filter-pattern "cold-start conversation"`, and a full `npm run eval` before completion.

### 6. Docs

Refresh `eval/README.md`: a "Multi-turn scenarios" subsection under "How test cases work"
(the `turns` schema, guard selection, session-resume mechanics, JSON parsing, cumulative
cost), and update the pipeline diagram/key-files table to mention `runConversation` /
`spawnCopilotTurn`.

## Out of scope

- ACP (`--acp`) driving — heavier protocol client; the resume-based driver reuses the existing
  spawn/provision/assert machinery and is sufficient.
- Converting other flows to multi-turn (onboard is the flagship; done later per-scenario by
  adding `turns`).
- PR-mode `sync` and any interactive-only paths.
