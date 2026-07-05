# Multi-turn Eval Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the OKH eval provider from a single `copilot -p` call into a guarded multi-turn conversation driver (over Copilot CLI session resume), and add a flagship onboard cold-start conversation scenario that verifies the staged multistep behaviour.

**Architecture:** A new `runConversation` driver spawns one `copilot -p ... --output-format json` process per turn, using `--session-id <uuid>` on turn 1 and `--resume=<uuid>` after, so context carries across turns. It parses JSONL events for the agent's messages, OKH tool calls, and cost, and picks the next scripted user message via optional per-turn regex guards. Scenarios with no `turns` run exactly one turn (backward compatible).

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), vitest (`vitest.eval.config.ts`), promptfoo custom provider, GitHub Copilot CLI.

**Verification commands (repo root, `D:\work\open-knowledge-hub`):**
- Type-check eval: `npm run typecheck:eval`
- Eval unit tests (all): `npm run test:eval`
- Single eval test file: `npx vitest run --config vitest.eval.config.ts eval-test/copilot.test.ts`
- promptfoo structural validation: `npm run eval:validate` (expect `Configuration is valid.`)
- Build server (before any live run): `npm run build`
- Live single scenario: `node --import tsx node_modules/promptfoo/dist/src/entrypoint.js eval -c eval/promptfooconfig.yaml --no-cache --filter-pattern "cold-start conversation"`
- Full live eval: `npm run eval`

---

## File Structure

- `eval/copilot.ts` — **modify**: keep `spawnCopilot`/`CopilotRunner`/`CopilotResult`/`CopilotRunOptions` (judge uses them); **remove** `extractToolCalls`; **add** `parseCopilotEvents`, `spawnCopilotTurn` (+ `CopilotTurnOptions`/`CopilotTurnResult`/`CopilotTurnRunner`/`ParsedTurn`), and `runConversation` (+ `Turn`/`ConversationScript`/`ConversationResult`/`ConversationTurn`/`RunConversationCtx`).
- `eval/provider/copilotProvider.ts` — **modify**: read optional `vars.turns`, drive `runConversation`, return aggregated transcript + `toolCalls`/`turns`/`cost` metadata.
- `eval/scenarios/onboard/cold-start-conversation.yaml` — **create**: flagship guarded multi-turn scenario.
- `eval-test/copilot.test.ts` — **rewrite**: `parseCopilotEvents` + `runConversation` (fake turn-runner).
- `eval-test/provider.test.ts` — **modify**: fakes → turn-runner shape; add a multi-turn case.
- `eval/README.md` — **modify**: multi-turn subsection + key-files/diagram touch-ups.

---

## Task 1: `parseCopilotEvents` (JSONL → structured turn)

**Files:**
- Modify: `eval/copilot.ts`
- Test: `eval-test/copilot.test.ts`

- [ ] **Step 1: Write the failing tests** — replace the entire body of `eval-test/copilot.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { parseCopilotEvents } from "../eval/copilot.js";

const line = (o: unknown) => JSON.stringify(o);

describe("parseCopilotEvents", () => {
  it("extracts OKH tool names from toolRequests and tool.execution_start", () => {
    const jsonl = [
      line({ type: "assistant.message", data: { content: "", toolRequests: [
        { mcpServerName: "open-knowledge-hub", mcpToolName: "onboard" },
      ] } }),
      line({ type: "tool.execution_start", data: { mcpServerName: "open-knowledge-hub", mcpToolName: "config" } }),
      line({ type: "tool.execution_start", data: { mcpServerName: "github-mcp-server", mcpToolName: "search_code" } }),
      line({ type: "assistant.message", data: { content: "All set." } }),
      line({ type: "result", sessionId: "abc", exitCode: 0, usage: { premiumRequests: 0.66 } }),
    ].join("\n");
    const p = parseCopilotEvents(jsonl);
    expect(p.tools).toEqual(["config", "onboard"]);
    expect(p.messages).toEqual(["All set."]);
    expect(p.lastMessage).toBe("All set.");
    expect(p.cost).toBe(0.66);
    expect(p.sessionId).toBe("abc");
    expect(p.code).toBe(0);
  });

  it("ignores non-OKH tool calls, blank messages, and non-JSON lines", () => {
    const jsonl = [
      "not json",
      line({ type: "assistant.reasoning_delta", data: { deltaContent: "thinking" } }),
      line({ type: "assistant.message", data: { content: "   " } }),
      line({ type: "tool.execution_start", data: { mcpServerName: "github-mcp-server", mcpToolName: "get_file_contents" } }),
    ].join("\n");
    const p = parseCopilotEvents(jsonl);
    expect(p.tools).toEqual([]);
    expect(p.messages).toEqual([]);
    expect(p.lastMessage).toBe("");
    expect(p.sessionId).toBeNull();
    expect(p.code).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/copilot.test.ts`
Expected: FAIL — `parseCopilotEvents` is not exported.

- [ ] **Step 3: Implement — edit `eval/copilot.ts`.** Remove `extractToolCalls` (the whole `const OKH_TOOLS ...` block and the function). Keep `spawnCopilot` and its interfaces. Add near the top (after the existing `spawnCopilot` definition):

```ts
export interface ParsedTurn {
  messages: string[];
  lastMessage: string;
  tools: string[];
  cost: number;
  sessionId: string | null;
  code: number | null;
}

const OKH_SERVER = "open-knowledge-hub";

interface ToolRequest {
  mcpServerName?: string;
  mcpToolName?: string;
}
interface EventData {
  content?: string;
  toolRequests?: ToolRequest[];
  mcpServerName?: string;
  mcpToolName?: string;
  sessionId?: string;
  exitCode?: number;
  usage?: { premiumRequests?: number };
}
interface CopilotEvent {
  type?: string;
  data?: EventData;
  sessionId?: string;
  exitCode?: number;
  usage?: { premiumRequests?: number };
}

/**
 * Parse Copilot CLI `--output-format json` (JSONL) from one turn: assistant
 * message contents, OKH MCP tool names (from `toolRequests[]` and
 * `tool.execution_start`, keyed on `mcpServerName === "open-knowledge-hub"`),
 * and the final `result` event's sessionId / exitCode / cumulative cost.
 */
export function parseCopilotEvents(jsonl: string): ParsedTurn {
  const messages: string[] = [];
  const tools = new Set<string>();
  let cost = 0;
  let sessionId: string | null = null;
  let code: number | null = null;

  for (const raw of jsonl.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t.startsWith("{")) continue;
    let e: CopilotEvent;
    try {
      e = JSON.parse(t) as CopilotEvent;
    } catch {
      continue;
    }
    const d = e.data ?? {};
    switch (e.type) {
      case "assistant.message": {
        if (typeof d.content === "string" && d.content.trim()) messages.push(d.content);
        for (const r of d.toolRequests ?? []) {
          if (r?.mcpServerName === OKH_SERVER && typeof r.mcpToolName === "string") tools.add(r.mcpToolName);
        }
        break;
      }
      case "tool.execution_start": {
        if (d.mcpServerName === OKH_SERVER && typeof d.mcpToolName === "string") tools.add(d.mcpToolName);
        break;
      }
      case "result": {
        sessionId = e.sessionId ?? d.sessionId ?? null;
        const pr = e.usage?.premiumRequests ?? d.usage?.premiumRequests;
        if (typeof pr === "number") cost = pr;
        const ec = e.exitCode ?? d.exitCode;
        if (typeof ec === "number") code = ec;
        break;
      }
    }
  }
  return { messages, lastMessage: messages.at(-1) ?? "", tools: [...tools].sort(), cost, sessionId, code };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/copilot.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add eval/copilot.ts eval-test/copilot.test.ts
git commit -m "feat(eval): parse Copilot CLI JSON events (replaces text-regex tool extractor)"
```

---

## Task 2: `spawnCopilotTurn` (one turn via session-id/resume, JSON output)

**Files:**
- Modify: `eval/copilot.ts`

No unit test spawns the real CLI (kept offline). This runner is exercised live in Task 7 and via the injected fake in Tasks 3–4.

- [ ] **Step 1: Add the turn runner to `eval/copilot.ts`** (after `parseCopilotEvents`):

```ts
export interface CopilotTurnOptions {
  /** The user message for THIS turn. */
  prompt: string;
  /** Session UUID we control; created on turn 1, resumed afterwards. */
  sessionId: string;
  /** false → `--session-id` (create); true → `--resume=` (continue). */
  resume: boolean;
  model?: string;
  copilotHome: string;
  cwd: string;
  timeoutMs?: number;
  /** Extra env merged over process.env (e.g. tokens). */
  extraEnv?: NodeJS.ProcessEnv;
}

export interface CopilotTurnResult extends ParsedTurn {
  /** Raw JSONL for debugging. */
  raw: string;
}

/** Injectable so tests never spawn the real `copilot`. */
export type CopilotTurnRunner = (opts: CopilotTurnOptions) => Promise<CopilotTurnResult>;

/** Default turn runner: spawns `copilot -p ... --output-format json`, parsing one turn. */
export const spawnCopilotTurn: CopilotTurnRunner = (opts) =>
  new Promise((resolve) => {
    const args = ["-p", opts.prompt, "--allow-all", "--output-format", "json", "--no-color"];
    if (opts.resume) args.push(`--resume=${opts.sessionId}`);
    else args.push("--session-id", opts.sessionId);
    if (opts.model) args.push("--model", opts.model);
    const child = spawn("copilot", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.extraEnv, COPILOT_HOME: opts.copilotHome },
      shell: false,
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const parsed = parseCopilotEvents(out);
      resolve({ ...parsed, raw: out, code: parsed.code ?? code });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      const parsed = parseCopilotEvents(out);
      resolve({ ...parsed, raw: `${out}\n[spawn error] ${(err as Error).message}`, code: null });
    });
  });
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck:eval`
Expected: exit 0 (no errors).

- [ ] **Step 3: Commit**

```bash
git add eval/copilot.ts
git commit -m "feat(eval): add spawnCopilotTurn (session-based JSON-mode turn runner)"
```

---

## Task 3: `runConversation` guarded driver

**Files:**
- Modify: `eval/copilot.ts`
- Test: `eval-test/copilot.test.ts`

- [ ] **Step 1: Add failing tests** — append to `eval-test/copilot.test.ts`:

```ts
import { runConversation, type CopilotTurnRunner, type CopilotTurnResult } from "../eval/copilot.js";

/** Fake turn-runner: scripts each turn's agent reply + tools by prompt substring. */
function fakeRunner(
  script: Array<{ match: string; agent: string; tools?: string[]; cost?: number; code?: number }>,
  seen: string[],
): CopilotTurnRunner {
  return async (opts): Promise<CopilotTurnResult> => {
    seen.push(opts.prompt);
    const hit = script.find((s) => opts.prompt.includes(s.match)) ?? { agent: "", tools: [], cost: 0, code: 0 };
    const messages = hit.agent ? [hit.agent] : [];
    return {
      messages,
      lastMessage: messages.at(-1) ?? "",
      tools: hit.tools ?? [],
      cost: hit.cost ?? 0,
      sessionId: opts.sessionId,
      code: hit.code ?? 0,
      raw: "",
    };
  };
}

const ctx = (runner: CopilotTurnRunner) => ({ runner, copilotHome: "/h", cwd: "/w" });

describe("runConversation", () => {
  it("sends turn 1, then picks guarded responses matching the agent's last message", async () => {
    const seen: string[] = [];
    const runner = fakeRunner(
      [
        { match: "start", agent: "Which wake phrase would you like?", tools: ["onboard"] },
        { match: "brain", agent: "Show me the plan? Ready to create?", tools: ["config"] },
        { match: "go ahead", agent: "Created. Here is how you use it day to day.", tools: ["add"] },
      ],
      seen,
    );
    const res = await runConversation(
      {
        initial: "start onboarding",
        responses: [
          { when: "wake phrase|name", send: "call it brain" },
          { when: "plan|create|ready", send: "yes go ahead" },
          { send: "thanks, everyday use?" },
        ],
      },
      ctx(runner),
    );
    expect(seen).toEqual(["start onboarding", "call it brain", "yes go ahead", "thanks, everyday use?"]);
    expect(res.toolCalls).toEqual(["add", "config", "onboard"]);
    expect(res.turns).toHaveLength(4);
    expect(res.transcript).toContain("=== USER (turn 1) ===");
    expect(res.transcript).toContain("Which wake phrase");
  });

  it("adapts when the agent reorders stages (guard match wins over declared order)", async () => {
    const seen: string[] = [];
    const runner = fakeRunner(
      [{ match: "start", agent: "First, which container? existing or new folder?" }],
      seen,
    );
    await runConversation(
      {
        initial: "start",
        responses: [
          { when: "wake phrase", send: "WAKE" },
          { when: "container|folder", send: "CONTAINER" },
        ],
      },
      ctx(runner),
    );
    // Agent asked about container first → the container-guarded reply fires before the wake reply.
    expect(seen[1]).toBe("CONTAINER");
  });

  it("stops when no response is eligible (all guarded, none match)", async () => {
    const seen: string[] = [];
    const runner = fakeRunner([{ match: "start", agent: "unrelated question" }], seen);
    const res = await runConversation(
      { initial: "start", responses: [{ when: "never-matches", send: "X" }] },
      ctx(runner),
    );
    expect(seen).toEqual(["start"]);
    expect(res.turns).toHaveLength(1);
  });

  it("caps the conversation at maxTurns", async () => {
    const seen: string[] = [];
    const runner = fakeRunner([], seen); // always empty agent reply
    const res = await runConversation(
      { initial: "start", responses: [{ send: "a" }, { send: "b" }, { send: "c" }], maxTurns: 2 },
      ctx(runner),
    );
    expect(res.turns).toHaveLength(2);
  });

  it("stops on a non-zero exit code", async () => {
    const seen: string[] = [];
    const runner = fakeRunner([{ match: "start", agent: "boom", code: 1 }], seen);
    const res = await runConversation(
      { initial: "start", responses: [{ send: "next" }] },
      ctx(runner),
    );
    expect(seen).toEqual(["start"]);
    expect(res.code).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/copilot.test.ts`
Expected: FAIL — `runConversation` not exported.

- [ ] **Step 3: Implement — add to `eval/copilot.ts`** (and add `import { randomUUID } from "node:crypto";` at the top):

```ts
export interface Turn {
  /** The user message to send. */
  send: string;
  /** Optional case-insensitive regex matched against the agent's last message. */
  when?: string;
}

export interface ConversationScript {
  /** Turn 1 user message (the promptfoo `{{prompt}}`). */
  initial: string;
  /** Guarded follow-up user messages. */
  responses: Turn[];
  /** Safety cap on total turns. Default: responses.length + 2. */
  maxTurns?: number;
}

export interface ConversationTurn {
  user: string;
  agent: string;
  tools: string[];
}

export interface ConversationResult {
  /** Aggregated, human-readable transcript (fed to the judge + transcript asserts). */
  transcript: string;
  /** Union of OKH tools called across all turns, sorted. */
  toolCalls: string[];
  turns: ConversationTurn[];
  /** Last turn's cumulative premiumRequests (== whole-conversation cost). */
  cost: number;
  /** Last turn's exit code. */
  code: number | null;
}

export interface RunConversationCtx {
  runner: CopilotTurnRunner;
  model?: string;
  copilotHome: string;
  cwd: string;
  timeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
}

function safeMatch(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false;
  }
}

/** Choose the next unsent response: a guard that matches the agent wins; else the first unguarded; else -1. */
function selectNext(responses: Turn[], sent: boolean[], lastAgent: string): number {
  for (let i = 0; i < responses.length; i++) {
    if (sent[i]) continue;
    const w = responses[i]!.when;
    if (w && safeMatch(w, lastAgent)) return i;
  }
  for (let i = 0; i < responses.length; i++) {
    if (!sent[i] && !responses[i]!.when) return i;
  }
  return -1;
}

/**
 * Drive a multi-turn Copilot CLI conversation over one resumed session. Turn 1
 * sends `initial`; after each turn the next scripted user message is picked by
 * guard match (falling back to declared order), until no response is eligible,
 * a turn errors, or `maxTurns` is reached.
 */
export async function runConversation(
  script: ConversationScript,
  ctx: RunConversationCtx,
): Promise<ConversationResult> {
  const sessionId = randomUUID();
  const responses = script.responses ?? [];
  const maxTurns = script.maxTurns ?? responses.length + 2;
  const sent = responses.map(() => false);
  const turns: ConversationTurn[] = [];
  const toolSet = new Set<string>();
  let cost = 0;
  let code: number | null = null;

  const runTurn = async (user: string, resume: boolean): Promise<CopilotTurnResult> => {
    const r = await ctx.runner({
      prompt: user,
      sessionId,
      resume,
      model: ctx.model,
      copilotHome: ctx.copilotHome,
      cwd: ctx.cwd,
      timeoutMs: ctx.timeoutMs,
      extraEnv: ctx.extraEnv,
    });
    turns.push({ user, agent: r.messages.join("\n"), tools: r.tools });
    for (const t of r.tools) toolSet.add(t);
    if (r.cost) cost = r.cost;
    code = r.code;
    return r;
  };

  let last = await runTurn(script.initial, false);
  while (turns.length < maxTurns) {
    if (last.code !== 0) break;
    const idx = selectNext(responses, sent, last.lastMessage);
    if (idx < 0) break;
    sent[idx] = true;
    last = await runTurn(responses[idx]!.send, true);
  }

  const transcript = turns
    .map((t, i) => `=== USER (turn ${i + 1}) ===\n${t.user}\n\n=== AGENT (turn ${i + 1}) ===\n${t.agent}`)
    .join("\n\n");

  return { transcript, toolCalls: [...toolSet].sort(), turns, cost, code };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/copilot.test.ts`
Expected: PASS (all `parseCopilotEvents` + `runConversation` tests).

- [ ] **Step 5: Commit**

```bash
git add eval/copilot.ts eval-test/copilot.test.ts
git commit -m "feat(eval): add runConversation guarded multi-turn driver"
```

---

## Task 4: Wire the provider to multi-turn

**Files:**
- Modify: `eval/provider/copilotProvider.ts`
- Test: `eval-test/provider.test.ts`

- [ ] **Step 1: Rewrite the failing test** — replace the whole body of `eval-test/provider.test.ts` with:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import CopilotProvider from "../eval/provider/copilotProvider.js";
import type { CopilotTurnRunner, CopilotTurnResult } from "../eval/copilot.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const exists = async (p: string) => !!(await stat(p).catch(() => null));

const turn = (over: Partial<CopilotTurnResult> = {}): CopilotTurnResult => ({
  messages: [],
  lastMessage: "",
  tools: [],
  cost: 0,
  sessionId: "s",
  code: 0,
  raw: "",
  ...over,
});

describe("CopilotProvider", () => {
  it("provisions the env, runs a single (faked) turn, and returns transcript + metadata", async () => {
    const fake: CopilotTurnRunner = async (opts) => {
      expect(opts.copilotHome).toContain("copilot-home");
      expect(opts.prompt).toBe("answer: how does auth work?");
      expect(opts.resume).toBe(false);
      return turn({ messages: ["auth uses tokens, done"], lastMessage: "auth uses tokens, done", tools: ["ask"] });
    };
    const provider = new CopilotProvider({ config: { model: "test-model", runner: fake } });
    expect(provider.id()).toBeTruthy();

    const res = await provider.callApi("answer: how does auth work?", {
      vars: { env: "local-and-git" },
      test: { description: "ask-grounded" },
    });
    cleanups.push(res.metadata.workspace);

    expect(res.output).toContain("done");
    expect(res.metadata.toolCalls).toContain("ask");
    expect(await exists(join(res.metadata.containerPath, ".okh", "okh.yaml"))).toBe(true);
  });

  it("drives guarded follow-up turns and aggregates tool calls across turns", async () => {
    const seen: string[] = [];
    const fake: CopilotTurnRunner = async (opts) => {
      seen.push(opts.prompt);
      if (opts.prompt.includes("set me up"))
        return turn({ messages: ["Pick a wake phrase"], lastMessage: "Pick a wake phrase", tools: ["onboard"] });
      if (opts.prompt.includes("brain"))
        return turn({ messages: ["Created it."], lastMessage: "Created it.", tools: ["config", "add"] });
      return turn();
    };
    const provider = new CopilotProvider({ config: { runner: fake } });
    const res = await provider.callApi("Use the hub and set me up.", {
      vars: {
        env: "empty",
        turns: [{ when: "wake phrase", send: "call it brain" }, { send: "thanks" }],
      },
      test: { description: "onboard-multi-turn" },
    });
    cleanups.push(res.metadata.workspace);

    expect(seen[0]).toBe("Use the hub and set me up.");
    expect(seen[1]).toBe("call it brain");
    expect(res.metadata.toolCalls).toEqual(["add", "config", "onboard"]);
    expect(res.metadata.turns.length).toBeGreaterThanOrEqual(2);
  });

  it("empty env yields an empty registry + an unregistered notes folder", async () => {
    const provider = new CopilotProvider({ config: { runner: async () => turn({ messages: ["ok"], lastMessage: "ok" }) } });
    const res = await provider.callApi("prompt", {
      vars: { env: "empty" },
      test: { description: "onboard-explains" },
    });
    cleanups.push(res.metadata.workspace);
    const reg = JSON.parse(await readFile(join(res.metadata.okhHome, "registry.json"), "utf8"));
    expect(reg.containers).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/provider.test.ts`
Expected: FAIL — provider still uses the old single-shot runner / `extractToolCalls`.

- [ ] **Step 3: Rewrite `eval/provider/copilotProvider.ts`:**

```ts
import { provisionEnvironment, isEnvName } from "../environments.js";
import { spawnCopilotTurn, runConversation, type CopilotTurnRunner, type Turn } from "../copilot.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(EVAL_ROOT, "..");

interface ProviderOptions {
  id?: string;
  config?: { model?: string; timeoutMs?: number; maxTurns?: number; runner?: CopilotTurnRunner };
}

interface CallContext {
  vars?: Record<string, unknown>;
  test?: { description?: string };
}

/** Normalise `vars.turns` (strings or `{ send, when? }`) into guarded Turns. */
function normalizeTurns(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  const out: Turn[] = [];
  for (const t of raw) {
    if (typeof t === "string") {
      out.push({ send: t });
    } else if (t && typeof t === "object" && typeof (t as { send?: unknown }).send === "string") {
      const o = t as { send: string; when?: unknown };
      out.push(typeof o.when === "string" ? { send: o.send, when: o.when } : { send: o.send });
    }
  }
  return out;
}

/**
 * promptfoo custom provider: provision a named environment, drive a (possibly
 * multi-turn) Copilot CLI conversation, and return the aggregated transcript +
 * metadata. With no `vars.turns` it runs exactly one turn (single-turn scenarios).
 */
export default class CopilotProvider {
  private readonly providerId: string;
  private readonly config: NonNullable<ProviderOptions["config"]>;

  constructor(options: ProviderOptions = {}) {
    this.providerId = options.id ?? "copilot-cli";
    this.config = options.config ?? {};
  }

  id(): string {
    return this.providerId;
  }

  async callApi(prompt: string, context: CallContext = {}) {
    const vars = context.vars ?? {};
    const env = vars.env;
    if (!isEnvName(env)) {
      throw new Error(`scenario is missing a valid \`env\` var (got ${JSON.stringify(env)})`);
    }
    const prov = await provisionEnvironment(env, { repoRoot: REPO_ROOT, label: env });

    const runner: CopilotTurnRunner = this.config.runner ?? spawnCopilotTurn;
    const result = await runConversation(
      {
        initial: prompt,
        responses: normalizeTurns(vars.turns),
        ...(this.config.maxTurns ? { maxTurns: this.config.maxTurns } : {}),
      },
      {
        runner,
        model: this.config.model,
        copilotHome: prov.copilotHome,
        cwd: prov.workspace,
        timeoutMs: this.config.timeoutMs ?? 300_000,
      },
    );

    return {
      output: result.transcript,
      metadata: {
        workspace: prov.root,
        okhHome: prov.okhHome,
        containerPath: prov.containerPath,
        fixtureDir: prov.fixtureDir,
        originPath: prov.originPath,
        toolCalls: result.toolCalls,
        turns: result.turns,
        cost: result.cost,
        exitCode: result.code,
      },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/provider.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full eval unit suite + type-check**

Run: `npm run typecheck:eval` then `npm run test:eval`
Expected: both exit 0; all eval tests pass (no remaining references to `extractToolCalls`).

- [ ] **Step 6: Commit**

```bash
git add eval/provider/copilotProvider.ts eval-test/provider.test.ts
git commit -m "feat(eval): drive multi-turn conversations from the provider via vars.turns"
```

---

## Task 5: Flagship onboard cold-start conversation scenario

**Files:**
- Create: `eval/scenarios/onboard/cold-start-conversation.yaml`

- [ ] **Step 1: Create the scenario file** with exactly:

```yaml
# onboard flow — a genuine multi-turn cold-start conversation: the harness plays
# the user, answering each stage (wake phrase → new container → confirm → wrap-up).
- config:
    - vars:
        env: empty
        prompt: |
          Use the Open Knowledge Hub MCP and run onboard to set me up.
        turns:
          - when: "wake phrase|name|call it|address|what.*call"
            send: "Let's call it 'brain'."
          - when: "existing|new folder|git|repository|which|container|set up"
            send: |
              Create a brand-new folder called "my-notes" with a knowledge module
              named "kb".
          - when: "plan|confirm|proceed|go ahead|create|shall i|ready|yes"
            send: "Yes, go ahead and create it."
          - send: "Thanks — how would I use it day to day?"
  tests:
    - description: Onboard - cold-start conversation - staged multi-turn setup
      assert:
        - type: javascript
          value: file://assertions/tools-called.ts
          config: { expect: [onboard, config, add] }
        - type: javascript
          value: file://assertions/wake-phrase-set.ts
        - type: javascript
          value: file://assertions/container-registered.ts
          config: { name: my-notes, backend: local, module: kb }
        - type: javascript
          value: file://assertions/manifest-initialized.ts
          config: { name: my-notes }
        - type: javascript
          value: file://assertions/judge.ts
          config:
            criteria:
              - id: ran-onboard
                text: The agent ran the onboard flow to begin guided setup.
                check: { kind: tool, name: onboard }
              - id: asked-wake-phrase
                text: Early on, the agent explained OKH briefly and asked the user to choose a wake phrase before doing setup.
              - id: set-wake-phrase
                text: The agent saved the user's chosen wake phrase via the config tool.
                check: { kind: wake-phrase }
              - id: previewed-before-create
                text: The agent showed or echoed the add plan and waited for a yes before creating anything.
              - id: created-hub-kb
                text: A container "my-notes" with a "kb" knowledge module was created.
                check: { kind: container, name: my-notes, backend: local, module: kb }
              - id: showed-everyday-use
                text: The agent closed by showing how to use the hub day to day (e.g. remember/learn/ask examples).
```

- [ ] **Step 2: Structural validation**

Run: `npm run eval:validate`
Expected: prints `Configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add eval/scenarios/onboard/cold-start-conversation.yaml
git commit -m "test(eval): add flagship multi-turn onboard cold-start conversation scenario"
```

---

## Task 6: Docs — `eval/README.md`

**Files:**
- Modify: `eval/README.md`

- [ ] **Step 1: Update the pipeline diagram** — in the "How it works" fenced block, replace the `shared provider` sub-tree lines so the driver is visible. Change:

```
  └─ shared provider (scenarios/shared/provider.ts → provider/copilotProvider.ts)
       ├─ provisionEnvironment(env)  ← environments.ts
```
to:
```
  └─ shared provider (scenarios/shared/provider.ts → provider/copilotProvider.ts)
       ├─ provisionEnvironment(env)  ← environments.ts
       ├─ runConversation(...)  ← copilot.ts (turn 1 --session-id, then --resume per turn; --output-format json)
```

- [ ] **Step 2: Update the key-files table** — change the `copilot.ts` row to:

```
| `copilot.ts` | spawns Copilot CLI turns; `runConversation` drives multi-turn (session resume, JSON output); `parseCopilotEvents` extracts messages/tools/cost |
```

- [ ] **Step 3: Add a "Multi-turn scenarios" subsection** immediately after the `### Environments` heading block ends (before `### Assertions`):

```markdown
### Multi-turn scenarios

Most scenarios are single-turn: one prompt, one agent reply. Conversational flows
(onboard) can instead declare `vars.turns` — a list of scripted **user** replies that
the harness sends across a resumed Copilot session (`--session-id` on turn 1, then
`--resume=<id>`), one `copilot -p` invocation per turn. In `-p` mode the agent ends
each turn with its question rather than blocking, so each turn is one conversational
step.

Each entry is a string (an ordered reply) or `{ send, when }`, where `when` is a
case-insensitive regex matched against the **agent's last message**. Per step the
harness picks the first unsent reply whose `when` matches; otherwise the first unsent
unguarded reply; otherwise the conversation ends (a `maxTurns` cap, default
`turns.length + 2`, guards against loops). This adapts if the agent reorders or
combines stages.

```yaml
# scenarios/onboard/cold-start-conversation.yaml (excerpt)
vars:
  env: empty
  prompt: "Use the Open Knowledge Hub MCP and run onboard to set me up."
  turns:
    - { when: "wake phrase|name|call it", send: "Let's call it 'brain'." }
    - { when: "new folder|which|container", send: "Create a new folder 'my-notes' with a 'kb' module." }
    - { when: "plan|confirm|go ahead|create", send: "Yes, go ahead and create it." }
    - { send: "Thanks — how would I use it day to day?" }   # unguarded fallback
```

The provider reads each turn via `--output-format json`, extracting the agent's
message, OKH tool calls (`mcpServerName: open-knowledge-hub`), and the run's
cumulative cost (`result.usage.premiumRequests`). The aggregated transcript
(labelled `USER`/`AGENT` blocks per turn) is what the judge and `transcript`
assertions grade, and `metadata.toolCalls` is the union across all turns.
```

- [ ] **Step 4: Commit**

```bash
git add eval/README.md
git commit -m "docs(eval): document multi-turn scenarios (vars.turns + session resume)"
```

---

## Task 7: End-to-end live verification

**Files:** none (verification only).

- [ ] **Step 1: Rebuild the server** (the harness runs `dist/index.js`):

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 2: Live-run the flagship scenario** (premium usage; requires `copilot` authenticated):

Run: `node --import tsx node_modules/promptfoo/dist/src/entrypoint.js eval -c eval/promptfooconfig.yaml --no-cache --filter-pattern "cold-start conversation"`
Expected: the scenario runs a real multi-turn conversation and the row PASSES all asserts (onboard/config/add called; wake phrase saved; `my-notes`/`kb` registered; judge criteria green). If a guard misses (a turn is skipped), tighten the `when` regexes in Task 5's file and re-run.

- [ ] **Step 3: Inspect the result** if needed:

Run: `npm run eval:view`
Expected: the report shows the new row green; the transcript shows labelled USER/AGENT turns.

- [ ] **Step 4: Full suite** (final gate for a larger change):

Run: `npm run eval`
Expected: all scenarios (16 existing single-turn + the new multi-turn) pass or are within self-consistency tolerance. Single-turn rows behave identically to before.

- [ ] **Step 5: Commit any regex/scenario tweaks** made during live iteration:

```bash
git add eval/scenarios/onboard/cold-start-conversation.yaml
git commit -m "test(eval): tune onboard conversation guards from live run"
```
