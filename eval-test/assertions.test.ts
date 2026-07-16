import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir, makeOrigin, pushToOrigin } from "../test/helpers.js";
import toolsCalled from "../eval/assertions/tools-called.js";
import toolArgument from "../eval/assertions/tool-argument.js";
import transcript from "../eval/assertions/transcript.js";
import okfValid from "../eval/assertions/okf-valid.js";
import memoryAppend from "../eval/assertions/memory-append.js";
import gitCommitted from "../eval/assertions/git-committed.js";
import moduleUnchanged from "../eval/assertions/module-unchanged.js";
import containerRegistered from "../eval/assertions/container-registered.js";
import manifestInitialized from "../eval/assertions/manifest-initialized.js";
import wakePhraseSet from "../eval/assertions/wake-phrase-set.js";
import llmwikiState from "../eval/assertions/llmwiki-state.js";
import { isDeepSubset, matchesTool, matchesToolAttempt, missingTools } from "../eval/assertions/tool-events.js";
import type { ToolEvent } from "../eval/copilot.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const ctx = (metadata: Record<string, unknown>, config: Record<string, unknown> = {}) =>
  ({ providerResponse: { metadata }, config });

const mkEvent = (overrides: Partial<ToolEvent> = {}): ToolEvent => ({
  turn: 1,
  callId: "c1",
  server: "open-knowledge-hub",
  tool: "run",
  arguments: {},
  completed: true,
  success: true,
  ...overrides,
});

describe("toolArgument", () => {
  it("checks successful structured tool arguments against regex boundaries", () => {
    const metadata = {
      toolEvents: [mkEvent({
        tool: "context",
        arguments: { task: "Implement a secure login feature. New implementation work; use one broad gap statement." },
      })],
    };
    const config = {
      tool: "context",
      argument: "task",
      mustContain: ["secure login", "broad gap"],
      mustNotContain: ["password|storage"],
    };
    expect(toolArgument("", ctx(metadata, config)).pass).toBe(true);
    expect(toolArgument("", ctx(metadata, { ...config, mustNotContain: ["implementation"] })).pass).toBe(false);
  });

  it("rejects missing, failed, or non-string arguments", () => {
    const config = { tool: "context", argument: "task" };
    expect(toolArgument("", ctx({ toolEvents: [] }, config)).pass).toBe(false);
    expect(toolArgument("", ctx({
      toolEvents: [mkEvent({ tool: "context", success: false, arguments: { task: "x" } })],
    }, config)).pass).toBe(false);
    expect(toolArgument("", ctx({
      toolEvents: [mkEvent({ tool: "context", arguments: { task: 1 } })],
    }, config)).pass).toBe(false);
  });
});

describe("isDeepSubset", () => {
  it("matches primitives with Object.is", () => {
    expect(isDeepSubset(42, 42)).toBe(true);
    expect(isDeepSubset("a", "a")).toBe(true);
    expect(isDeepSubset(42, 43)).toBe(false);
  });
  it("matches nested object subsets recursively", () => {
    expect(isDeepSubset({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toBe(true);
    expect(isDeepSubset({ a: 1, b: { c: 2 } }, { b: { c: 99 } })).toBe(false);
  });
  it("arrays are not treated as object subsets — must match exactly", () => {
    expect(isDeepSubset([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(isDeepSubset([1, 2, 3], [1, 2])).toBe(false);
  });
  it("null handling", () => {
    expect(isDeepSubset(null, null)).toBe(true);
    expect(isDeepSubset(null, {})).toBe(false);
    expect(isDeepSubset({}, null)).toBe(false);
  });
});

describe("matchesTool", () => {
  it("matches a successful completed event with matching tool and server", () => {
    const ev = mkEvent({ tool: "run", arguments: { module: "wiki", skill: "write" } });
    expect(matchesTool(ev, { name: "run", arguments: { module: "wiki", skill: "write" } })).toBe(true);
  });

  describe("matchesToolAttempt", () => {
    it("matches failed and incomplete attempts", () => {
      expect(matchesToolAttempt(mkEvent({ completed: true, success: false }), { name: "run" })).toBe(true);
      expect(matchesToolAttempt(mkEvent({ completed: false, success: false }), { name: "run" })).toBe(true);
    });
  });
  it("rejects when completed is false", () => {
    expect(matchesTool(mkEvent({ completed: false }), { name: "run" })).toBe(false);
  });
  it("rejects when success is false", () => {
    expect(matchesTool(mkEvent({ success: false }), { name: "run" })).toBe(false);
  });
  it("defaults server to open-knowledge-hub", () => {
    expect(matchesTool(mkEvent({ server: "other" }), { name: "run" })).toBe(false);
    expect(matchesTool(mkEvent({ server: "open-knowledge-hub" }), { name: "run" })).toBe(true);
  });
  it("matches explicit server override", () => {
    expect(matchesTool(mkEvent({ server: "custom" }), { name: "run", server: "custom" })).toBe(true);
  });
  it("matches optional turn exactly", () => {
    expect(matchesTool(mkEvent({ turn: 2 }), { name: "run", turn: 2 })).toBe(true);
    expect(matchesTool(mkEvent({ turn: 1 }), { name: "run", turn: 2 })).toBe(false);
  });
  it("matches deep argument subsets", () => {
    const ev = mkEvent({ tool: "run", arguments: { module: "wiki", skill: "write", extra: true } });
    expect(matchesTool(ev, { name: "run", arguments: { module: "wiki" } })).toBe(true);
    expect(matchesTool(ev, { name: "run", arguments: { module: "other" } })).toBe(false);
  });
});

describe("missingTools", () => {
  const events: ToolEvent[] = [
    mkEvent({ tool: "run", callId: "c1", arguments: { module: "wiki", skill: "write" } }),
    mkEvent({ tool: "inspect", callId: "c2", arguments: { module: "wiki" } }),
    mkEvent({ tool: "sync", callId: "c3", arguments: { container: "wiki-hub" } }),
  ];

  it("returns empty array when all expectations match (unordered)", () => {
    expect(missingTools(events, [
      { name: "run", arguments: { module: "wiki", skill: "write" } },
      { name: "inspect", arguments: { module: "wiki" } },
      { name: "sync", arguments: { container: "wiki-hub" } },
    ])).toEqual([]);
  });

  it("returns missing for wrong module argument", () => {
    const result = missingTools(events, [{ name: "run", arguments: { module: "other" } }]);
    expect(result).toHaveLength(1);
  });

  it("returns empty for ordered:true with correct order", () => {
    expect(missingTools(events, [
      { name: "run", arguments: { module: "wiki", skill: "write" } },
      { name: "inspect", arguments: { module: "wiki" } },
      { name: "sync", arguments: { container: "wiki-hub" } },
    ], true)).toEqual([]);
  });

  it("returns unmatched when order is reversed with ordered:true", () => {
    const result = missingTools(events, [
      { name: "sync", arguments: { container: "wiki-hub" } },
      { name: "run", arguments: { module: "wiki", skill: "write" } },
    ], true);
    // sync is at index 2, run is at index 0 — can't match monotonically after sync
    expect(result.length).toBeGreaterThan(0);
  });

  it("skips events with success:false", () => {
    const failedEvents: ToolEvent[] = [
      mkEvent({ tool: "run", success: false }),
    ];
    expect(missingTools(failedEvents, ["run"])).toEqual(["run"]);
  });

  it("handles string expectations against successful events", () => {
    expect(missingTools(events, ["run", "inspect", "sync"])).toEqual([]);
    expect(missingTools(events, ["run", "missing"])).toEqual(["missing"]);
  });

  it("does not reuse one event for duplicate unordered expectations", () => {
    expect(missingTools([mkEvent({ tool: "run" })], ["run", "run"])).toEqual(["run"]);
  });

  it("finds a complete unordered assignment when generic and specific expectations overlap", () => {
    const overlapping = [
      mkEvent({ tool: "run", callId: "c1", arguments: { skill: "learn" } }),
      mkEvent({ tool: "run", callId: "c2", arguments: { skill: "other" } }),
    ];
    expect(missingTools(overlapping, [
      "run",
      { name: "run", arguments: { skill: "learn" } },
    ])).toEqual([]);
  });
});

describe("tools-called", () => {
  it("passes when expected tools are present, fails when missing", () => {
    const evts = [
      mkEvent({ tool: "ask", callId: "c1" }),
      mkEvent({ tool: "sync", callId: "c2" }),
    ];
    expect(toolsCalled("", ctx({ toolCalls: ["ask", "sync"], toolEvents: evts }, { expect: ["ask"] })).pass).toBe(true);
    expect(toolsCalled("", ctx({ toolCalls: ["ask"], toolEvents: [mkEvent({ tool: "ask" })] }, { expect: ["learn"] })).pass).toBe(false);
  });

  it("passes with structured ToolExpectation and ordered:true", () => {
    const evts: ToolEvent[] = [
      mkEvent({ tool: "run", callId: "c1", arguments: { module: "wiki", skill: "write" } }),
      mkEvent({ tool: "inspect", callId: "c2", arguments: { module: "wiki" } }),
      mkEvent({ tool: "sync", callId: "c3", arguments: { container: "wiki-hub" } }),
    ];
    const result = toolsCalled("", ctx(
      { toolCalls: ["inspect", "run", "sync"], toolEvents: evts },
      {
        expect: [
          { name: "run", arguments: { module: "wiki", skill: "write" } },
          { name: "inspect", arguments: { module: "wiki" } },
          { name: "sync", arguments: { container: "wiki-hub" } },
        ],
        ordered: true,
      },
    ));
    expect(result.pass).toBe(true);
  });

  it("fails with ordered:true when order is reversed", () => {
    const evts: ToolEvent[] = [
      mkEvent({ tool: "sync", callId: "c1", arguments: { container: "wiki-hub" } }),
      mkEvent({ tool: "run", callId: "c2", arguments: { module: "wiki", skill: "write" } }),
    ];
    const result = toolsCalled("", ctx(
      { toolCalls: ["run", "sync"], toolEvents: evts },
      {
        expect: [
          { name: "run", arguments: { module: "wiki", skill: "write" } },
          { name: "sync", arguments: { container: "wiki-hub" } },
        ],
        ordered: true,
      },
    ));
    expect(result.pass).toBe(false);
  });

  it("fails when event has success:false even if tool name matches", () => {
    const evts: ToolEvent[] = [
      mkEvent({ tool: "run", success: false }),
    ];
    const result = toolsCalled("", ctx(
      { toolCalls: [], toolEvents: evts },
      { expect: [{ name: "run" }] },
    ));
    expect(result.pass).toBe(false);
  });

  it("fails when a forbidden tool was called successfully", () => {
    const evts = [
      mkEvent({ tool: "run", callId: "c1" }),
      mkEvent({ tool: "sync", callId: "c2" }),
    ];
    const result = toolsCalled("", ctx(
      { toolCalls: ["run", "sync"], toolEvents: evts },
      { expect: ["run"], forbid: ["sync"] },
    ));
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("forbidden tool calls: sync");
  });

  it.each([
    { completed: true, success: false },
    { completed: false, success: false },
  ])("fails when a forbidden tool was attempted: %o", (state) => {
    const result = toolsCalled("", ctx(
      { toolCalls: [], toolEvents: [mkEvent({ tool: "sync", ...state })] },
      { forbid: ["sync"] },
    ));
    expect(result.pass).toBe(false);
  });
});

describe("transcript", () => {
  it("checks mustContain / mustNotContain", () => {
    expect(transcript("see kb/auth.md", ctx({}, { mustContain: ["kb/auth.md"] })).pass).toBe(true);
    expect(transcript("boom error", ctx({}, { mustNotContain: ["error"] })).pass).toBe(false);
  });

  it("can validate only the final spoken assistant message", () => {
    const metadata = { finalMessage: "Use tools/csv2json/README.md to inspect CSV data." };
    expect(transcript(
      "tool output mentioned kb/auth.md",
      ctx(metadata, {
        source: "final-message",
        mustContain: ["csv2json"],
        mustNotContain: ["auth\\.md"],
      }),
    ).pass).toBe(true);
  });

  it("fails final-message checks when metadata is absent", () => {
    const result = transcript("token appears in the prompt", ctx({}, {
      source: "final-message",
      mustContain: ["token"],
    }));
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/missing or empty/i);
  });
});

describe("okf-valid", () => {
  it("passes for valid OKF concepts, fails when a concept lacks a type", async () => {
    const c = await makeTempDir("okf-"); cleanups.push(c);
    await mkdir(join(c, "kb"), { recursive: true });
    await writeFile(join(c, "kb", "index.md"), "# Knowledge\n", "utf8");
    await writeFile(join(c, "kb", "auth.md"), "---\ntype: Concept\ntitle: Auth\n---\n# Auth\n# Citations\n[1] src\n", "utf8");
    expect((await okfValid("", ctx({ containerPath: c }, { module: "kb", requireCitations: true }))).pass).toBe(true);

    await writeFile(join(c, "kb", "bad.md"), "no frontmatter here\n", "utf8");
    expect((await okfValid("", ctx({ containerPath: c }, { module: "kb" }))).pass).toBe(false);
  });

  it("validates uppercase Markdown concept extensions", async () => {
    const c = await makeTempDir("okf-"); cleanups.push(c);
    await mkdir(join(c, "kb"), { recursive: true });
    await writeFile(join(c, "kb", "valid.md"), "---\ntype: Concept\n---\nvalid\n", "utf8");
    await writeFile(join(c, "kb", "bad.MD"), "missing frontmatter\n", "utf8");
    const result = await okfValid("", ctx({ containerPath: c }, { module: "kb" }));
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/bad\.MD: missing frontmatter type/i);
  });

  it("with requireChanged, fails when the module equals the fixture and passes when a concept changed", async () => {
    const fx = await makeTempDir("okf-fx-"); cleanups.push(fx);
    const c = await makeTempDir("okf-c-"); cleanups.push(c);
    await mkdir(join(fx, "kb"), { recursive: true });
    await mkdir(join(c, "kb"), { recursive: true });
    await writeFile(join(fx, "kb", "index.md"), "# Knowledge\n", "utf8");
    await writeFile(join(fx, "kb", "auth.md"), "---\ntype: Concept\n---\nbody\n", "utf8");
    await writeFile(join(c, "kb", "index.md"), "# Knowledge\n", "utf8");
    await writeFile(join(c, "kb", "auth.md"), "---\ntype: Concept\n---\nbody\n", "utf8");
    const meta = { containerPath: c, fixtureDir: fx };
    expect((await okfValid("", ctx(meta, { module: "kb", requireChanged: true }))).pass).toBe(false);
    // extend the existing concept (as a real learn run may) -> changed -> passes
    await writeFile(join(c, "kb", "auth.md"), "---\ntype: Concept\n---\nbody\n\n# Signing\nRS256\n", "utf8");
    expect((await okfValid("", ctx(meta, { module: "kb", requireChanged: true }))).pass).toBe(true);
  });

  it("requires configured patterns in files changed from the fixture", async () => {
    const fx = await makeTempDir("okf-fx-"); cleanups.push(fx);
    const c = await makeTempDir("okf-c-"); cleanups.push(c);
    await mkdir(join(fx, "kb"), { recursive: true });
    await mkdir(join(c, "kb"), { recursive: true });
    const original = "---\ntype: Concept\n---\nSigned tokens.\n";
    await writeFile(join(fx, "kb", "auth.md"), original, "utf8");
    await writeFile(join(c, "kb", "auth.md"), `${original}\nRS256 keys rotate weekly.\n`, "utf8");
    const meta = { containerPath: c, fixtureDir: fx };

    expect((await okfValid("", ctx(meta, {
      module: "kb",
      requiredChangedPatterns: ["RS256", "weekly"],
    }))).pass).toBe(true);
    expect((await okfValid("", ctx(meta, {
      module: "kb",
      requiredChangedPatterns: ["HS256"],
    }))).pass).toBe(false);
  });

  it("does not accept required patterns written only to reserved index or log files", async () => {
    const fx = await makeTempDir("okf-fx-"); cleanups.push(fx);
    const c = await makeTempDir("okf-c-"); cleanups.push(c);
    await mkdir(join(fx, "kb"), { recursive: true });
    await mkdir(join(c, "kb"), { recursive: true });
    const concept = "---\ntype: Concept\n---\nSigned tokens.\n";
    await writeFile(join(fx, "kb", "auth.md"), concept, "utf8");
    await writeFile(join(c, "kb", "auth.md"), concept, "utf8");
    await writeFile(join(fx, "kb", "index.md"), "# Knowledge\n", "utf8");
    await writeFile(join(c, "kb", "index.md"), "# Knowledge\nRS256 keys rotate weekly.\n", "utf8");

    const result = await okfValid("", ctx(
      { containerPath: c, fixtureDir: fx },
      { module: "kb", requiredChangedPatterns: ["RS256", "weekly"] },
    ));
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/no concept document/i);
  });
});

describe("memory-append", () => {
  const observation = "The login endpoint returned 500s for ~3 minutes at 14:05 UTC during deploy.";

  async function pair(): Promise<{ fx: string; c: string }> {
    const fx = await makeTempDir("mem-fx-"); cleanups.push(fx);
    const c = await makeTempDir("mem-"); cleanups.push(c);
    await mkdir(join(fx, "mem"), { recursive: true });
    await mkdir(join(c, "mem"), { recursive: true });
    await writeFile(join(fx, "mem", "2026-01-01.md"), "old\n", "utf8");
    await writeFile(join(c, "mem", "2026-01-01.md"), "old\n", "utf8");
    return { fx, c };
  }

  function validEntry(obs: string): string {
    return `## 2026-07-02T14:05:00Z\n\n${obs}\n`;
  }

  it("passes when a new file has exactly one timestamp heading and the exact observation", async () => {
    const { fx, c } = await pair();
    await writeFile(join(c, "mem", "2026-07-02.md"), validEntry(observation), "utf8");
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", observation }));
    expect(r.pass).toBe(true);
  });

  it("passes when observation is appended to an existing file (prior content preserved as prefix)", async () => {
    const { fx, c } = await pair();
    const prior = "old\n";
    await writeFile(join(c, "mem", "2026-01-01.md"), prior + "\n" + validEntry(observation), "utf8");
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", observation }));
    expect(r.pass).toBe(true);
  });

  it("fails when an extra 'completed successfully' sentence is appended after the observation", async () => {
    const { fx, c } = await pair();
    const extra = `## 2026-07-02T14:05:00Z\n\n${observation}\nCompleted successfully.\n`;
    await writeFile(join(c, "mem", "2026-07-02.md"), extra, "utf8");
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", observation }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/extra non-empty line/i);
  });

  it("fails when a new memory file adds YAML frontmatter", async () => {
    const { fx, c } = await pair();
    const extra = `---\ndate: 2026-07-02\n---\n${validEntry(observation)}`;
    await writeFile(join(c, "mem", "2026-07-02.md"), extra, "utf8");
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", observation }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/extra non-empty line/i);
  });

  it("fails when two Markdown files were added", async () => {
    const { fx, c } = await pair();
    await writeFile(join(c, "mem", "2026-07-02.md"), validEntry(observation), "utf8");
    await writeFile(join(c, "mem", "2026-07-03.md"), validEntry(observation), "utf8");
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", observation }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/exactly one/i);
  });

  it("fails when two timestamp entries exist in the appended content", async () => {
    const { fx, c } = await pair();
    const double = `## 2026-07-02T14:05:00Z\n\n${observation}\n\n## 2026-07-02T14:06:00Z\n\nAnother entry.\n`;
    await writeFile(join(c, "mem", "2026-07-02.md"), double, "utf8");
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", observation }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/exactly one.*timestamp/i);
  });

  it("fails when prior content was rewritten (changed file does not start with prior content)", async () => {
    const { fx, c } = await pair();
    await writeFile(join(c, "mem", "2026-01-01.md"), "REWRITTEN\n" + validEntry(observation), "utf8");
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", observation }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/prior content/i);
  });

  it("fails when a prior Markdown file was deleted", async () => {
    const { fx, c } = await pair();
    const { rm: fsRm } = await import("node:fs/promises");
    await fsRm(join(c, "mem", "2026-01-01.md"));
    await writeFile(join(c, "mem", "2026-07-02.md"), validEntry(observation), "utf8");
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", observation }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/removed/i);
  });

  it("fails when the exact observation text is missing from appended content", async () => {
    const { fx, c } = await pair();
    const wrong = `## 2026-07-02T14:05:00Z\n\nSomething else entirely.\n`;
    await writeFile(join(c, "mem", "2026-07-02.md"), wrong, "utf8");
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", observation }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/observation not found/i);
  });

  it("fails when observation config is missing", async () => {
    const { fx, c } = await pair();
    await writeFile(join(c, "mem", "2026-07-02.md"), validEntry(observation), "utf8");
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem" }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/observation.*required/i);
  });

  it("preserves multiline observations verbatim", async () => {
    const { fx, c } = await pair();
    const multiObs = "Line one of observation.\nLine two with detail.\nLine three final.";
    await writeFile(join(c, "mem", "2026-07-02.md"), validEntry(multiObs), "utf8");
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", observation: multiObs }));
    expect(r.pass).toBe(true);
  });

  it("passes when file uses CRLF line endings (Windows)", async () => {
    const { fx, c } = await pair();
    // Simulate a valid memory append written with CRLF (Windows git autocrlf)
    const crlfContent = "## 2026-07-02T14:05:00Z\r\n\r\n" + observation + "\r\n";
    await writeFile(join(c, "mem", "2026-07-02.md"), crlfContent, "utf8");
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", observation }));
    expect(r.pass).toBe(true);
  });

  it("passes when multiline observation uses CRLF in the file but LF in config", async () => {
    const { fx, c } = await pair();
    const multiObs = "Line one of observation.\nLine two with detail.\nLine three final.";
    // File has CRLF but observation config uses LF
    const crlfContent = "## 2026-07-02T14:05:00Z\r\n\r\nLine one of observation.\r\nLine two with detail.\r\nLine three final.\r\n";
    await writeFile(join(c, "mem", "2026-07-02.md"), crlfContent, "utf8");
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", observation: multiObs }));
    expect(r.pass).toBe(true);
  });

  it("fails when no markdown file was added or changed", async () => {
    const { fx, c } = await pair();
    const r = await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", observation }));
    expect(r.pass).toBe(false);
  });
});

describe("module-unchanged", () => {
  it("passes when the module equals the fixture, fails when a file was added", async () => {
    const fx = await makeTempDir("mu-fx-"); cleanups.push(fx);
    const c = await makeTempDir("mu-"); cleanups.push(c);
    await mkdir(join(fx, "kb"), { recursive: true });
    await mkdir(join(c, "kb"), { recursive: true });
    await writeFile(join(fx, "kb", "index.md"), "# k\n", "utf8");
    await writeFile(join(c, "kb", "index.md"), "# k\n", "utf8");
    expect((await moduleUnchanged("", ctx({ containerPath: c, fixtureDir: fx }, { module: "kb" }))).pass).toBe(true);
    await writeFile(join(c, "kb", "sky.md"), "the sky is blue\n", "utf8"); // unwanted write
    expect((await moduleUnchanged("", ctx({ containerPath: c, fixtureDir: fx }, { module: "kb" }))).pass).toBe(false);
  });
});

describe("git-committed", () => {
  it("passes when the origin has commits beyond the seed", async () => {
    const origin = await makeOrigin({ "kb/index.md": "# k\n" }); // 1 commit
    expect((await gitCommitted("", ctx({ originPath: origin }, { minCommits: 2 }))).pass).toBe(false);
    await pushToOrigin(origin, "kb/auth.md", "x"); // 2nd commit
    expect((await gitCommitted("", ctx({ originPath: origin }, { minCommits: 2 }))).pass).toBe(true);
  });
  it("fails cleanly for a non-git container", async () => {
    expect((await gitCommitted("", ctx({}, {}))).pass).toBe(false);
  });
});

async function okhHomeWith(name: string): Promise<string> {
  const home = await makeTempDir(); cleanups.push(home);
  const containers = join(home, "containers", name);
  await mkdir(join(containers, "kb", ".okh"), { recursive: true });
  await writeFile(join(containers, "kb", ".okh", "module.yaml"), `type: knowledge\nname: kb\ndescription: Test\n`, "utf8");
  await writeFile(join(home, "registry.json"), JSON.stringify({
    version: 1,
    containers: [{ name, backend: "local", localPath: containers, sync: "auto", addedAt: new Date().toISOString() }],
  }), "utf8");
  return home;
}

describe("onboarding assertions", () => {
  it("container-registered passes when the container exists with a valid manifest", async () => {
    const okhHome = await okhHomeWith("my-notes");
    const r = await containerRegistered("", { providerResponse: { metadata: { okhHome } }, config: { name: "my-notes", backend: "local" } });
    expect(r.pass).toBe(true);
  });

  it("container-registered fails when nothing is registered", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    await writeFile(join(home, "registry.json"), JSON.stringify({ version: 1, containers: [] }), "utf8");
    const r = await containerRegistered("", { providerResponse: { metadata: { okhHome: home } }, config: { name: "my-notes" } });
    expect(r.pass).toBe(false);
  });

  it("manifest-initialized passes for a registered container", async () => {
    const okhHome = await okhHomeWith("my-notes");
    const r = await manifestInitialized("", { providerResponse: { metadata: { okhHome } }, config: { name: "my-notes" } });
    expect(r.pass).toBe(true);
  });

  it("manifest-initialized fails when a registered container has no modules", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const containers = join(home, "containers", "my-notes");
    await mkdir(containers, { recursive: true });
    await writeFile(join(home, "registry.json"), JSON.stringify({
      version: 1,
      containers: [{ name: "my-notes", backend: "local", localPath: containers, sync: "auto", addedAt: new Date().toISOString() }],
    }), "utf8");
    const r = await manifestInitialized("", { providerResponse: { metadata: { okhHome: home } }, config: { name: "my-notes" } });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/no modules discovered/);
  });

  it("wake-phrase-set passes when a non-default phrase is persisted", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    await writeFile(join(home, "preferences.json"), JSON.stringify({ wakePhrase: "brain" }), "utf8");
    const r = await wakePhraseSet("", { providerResponse: { metadata: { okhHome: home } }, config: {} });
    expect(r.pass).toBe(true);
  });

  it("wake-phrase-set fails when the default phrase is unchanged", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    await writeFile(join(home, "preferences.json"), JSON.stringify({ wakePhrase: "hub" }), "utf8");
    const r = await wakePhraseSet("", { providerResponse: { metadata: { okhHome: home } }, config: { default: "hub" } });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("unchanged");
  });

  it("wake-phrase-set reports malformed preferences separately from a missing file", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    await writeFile(join(home, "preferences.json"), "{", "utf8");
    const r = await wakePhraseSet("", { providerResponse: { metadata: { okhHome: home } }, config: {} });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/invalid preferences\.json/);
  });
});

describe("llmwiki-state", () => {
  async function wikiPair() {
    const fx = await makeTempDir("wiki-fx-"); cleanups.push(fx);
    const c = await makeTempDir("wiki-"); cleanups.push(c);
    return { fx, c };
  }

  async function scaffoldModule(root: string, module: string, opts?: { extraFiles?: Record<string, string> }) {
    const dir = join(root, module);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.md"), "# Wiki Index\n\nTopics: attention, transformer\n\n* [syntheses/attention-transformer.md](syntheses/attention-transformer.md)\n", "utf8");
    await writeFile(join(dir, "log.md"), "# Update Log\n\n## 2026-07-01\n\n- Initial setup\n", "utf8");
    await mkdir(join(dir, "syntheses"), { recursive: true });
    if (opts?.extraFiles) {
      for (const [rel, content] of Object.entries(opts.extraFiles)) {
        const parts = rel.split("/");
        if (parts.length > 1) await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
        await writeFile(join(dir, rel), content, "utf8");
      }
    }
  }

  it("passes initialization matching required index text and group indexes with no content pages", async () => {
    const { fx, c } = await wikiPair();
    await scaffoldModule(fx, "wiki");
    await scaffoldModule(c, "wiki");
    const r = await llmwikiState("", ctx({ containerPath: c, fixtureDir: fx }, {
      module: "wiki",
      requiredIndexText: ["attention", "transformer"],
      requiredGroupIndexes: ["syntheses"],
      noContentPages: true,
    }));
    expect(r.pass).toBe(true);
  });

  it("passes write with new synthesis page, terms, root index/log changed, clean health", async () => {
    const { fx, c } = await wikiPair();
    await scaffoldModule(fx, "wiki");
    await scaffoldModule(c, "wiki", {
      extraFiles: {
        "syntheses/attention-transformer.md":
          "---\ntype: synthesis\ntitle: Attention and Transformer\n---\n# Attention and Transformer\n\nThe attention mechanism is a key component of the [transformer overview](transformer-overview.md) architecture.\n",
        "syntheses/transformer-overview.md":
          "---\ntype: synthesis\ntitle: Transformer Overview\n---\n# Transformer Overview\n\nSee also [attention-transformer](attention-transformer.md).\n",
      },
    });
    // Modify index and log to simulate write; index links to both pages
    await writeFile(join(c, "wiki", "index.md"), "# Wiki Index\n\nTopics: attention, transformer\n\n* [syntheses/attention-transformer.md](syntheses/attention-transformer.md)\n* [syntheses/transformer-overview.md](syntheses/transformer-overview.md)\n", "utf8");
    await writeFile(join(c, "wiki", "log.md"), "# Update Log\n\n## 2026-07-10\n\n- Added attention-transformer synthesis\n\n## 2026-07-01\n\n- Initial setup\n", "utf8");
    const r = await llmwikiState("", ctx({ containerPath: c, fixtureDir: fx }, {
      module: "wiki",
      expectedNewPage: { folder: "syntheses", type: "synthesis", terms: ["attention", "transformer"] },
      requireIndexAndLogChanged: true,
      requireCleanHealth: true,
    }));
    expect(r.pass).toBe(true);
  });

  it("fails when expected type does not match", async () => {
    const { fx, c } = await wikiPair();
    await scaffoldModule(fx, "wiki");
    await scaffoldModule(c, "wiki", {
      extraFiles: {
        "syntheses/attention-transformer.md":
          "---\ntype: concept\ntitle: Attention and Transformer\n---\n# Attention and Transformer\n\nAttention transformer content.\n",
      },
    });
    await writeFile(join(c, "wiki", "index.md"), "# Wiki Index\n\nUpdated\n", "utf8");
    await writeFile(join(c, "wiki", "log.md"), "# Update Log\n\nUpdated\n", "utf8");
    const r = await llmwikiState("", ctx({ containerPath: c, fixtureDir: fx }, {
      module: "wiki",
      expectedNewPage: { folder: "syntheses", type: "synthesis", terms: ["attention", "transformer"] },
      requireIndexAndLogChanged: true,
    }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/type/i);
  });

  it("fails when new page is in wrong folder", async () => {
    const { fx, c } = await wikiPair();
    await scaffoldModule(fx, "wiki");
    await scaffoldModule(c, "wiki", {
      extraFiles: {
        "concepts/attention-transformer.md":
          "---\ntype: synthesis\ntitle: Attention Transformer\n---\n# Attention Transformer\n\nAttention and transformer content.\n",
      },
    });
    await writeFile(join(c, "wiki", "index.md"), "# Wiki Index\n\nUpdated\n", "utf8");
    await writeFile(join(c, "wiki", "log.md"), "# Update Log\n\nUpdated\n", "utf8");
    const r = await llmwikiState("", ctx({ containerPath: c, fixtureDir: fx }, {
      module: "wiki",
      expectedNewPage: { folder: "syntheses", type: "synthesis", terms: ["attention", "transformer"] },
      requireIndexAndLogChanged: true,
    }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/folder|no added.*syntheses/i);
  });

  it("fails when root index/log not changed", async () => {
    const { fx, c } = await wikiPair();
    await scaffoldModule(fx, "wiki");
    await scaffoldModule(c, "wiki", {
      extraFiles: {
        "syntheses/attention-transformer.md":
          "---\ntype: synthesis\ntitle: Attention and Transformer\n---\n# Attention and Transformer\n\nAttention transformer.\n",
      },
    });
    const r = await llmwikiState("", ctx({ containerPath: c, fixtureDir: fx }, {
      module: "wiki",
      expectedNewPage: { folder: "syntheses", type: "synthesis", terms: ["attention", "transformer"] },
      requireIndexAndLogChanged: true,
    }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/index\.md|log\.md/i);
  });

  it("fails when initialization finds a content page with noContentPages", async () => {
    const { fx, c } = await wikiPair();
    await scaffoldModule(fx, "wiki");
    await scaffoldModule(c, "wiki", {
      extraFiles: { "concepts/topic.md": "---\ntype: concept\n---\n# Topic\n" },
    });
    const r = await llmwikiState("", ctx({ containerPath: c, fixtureDir: fx }, {
      module: "wiki",
      noContentPages: true,
    }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/content page/i);
  });

  it("fails when health is not clean", async () => {
    const { fx, c } = await wikiPair();
    await scaffoldModule(fx, "wiki");
    // Add a page with dangling link and missing type to cause health issues
    await scaffoldModule(c, "wiki", {
      extraFiles: {
        "syntheses/attention-transformer.md":
          "---\ntype: synthesis\ntitle: Attention Transformer\n---\n# Attention Transformer\n\nSee [missing](../nonexistent.md) for attention and transformer details.\n",
      },
    });
    await writeFile(join(c, "wiki", "index.md"), "# Wiki Index\n\nUpdated with [link](syntheses/attention-transformer.md)\n", "utf8");
    await writeFile(join(c, "wiki", "log.md"), "# Update Log\n\nUpdated\n", "utf8");
    const r = await llmwikiState("", ctx({ containerPath: c, fixtureDir: fx }, {
      module: "wiki",
      expectedNewPage: { folder: "syntheses", type: "synthesis", terms: ["attention", "transformer"] },
      requireIndexAndLogChanged: true,
      requireCleanHealth: true,
    }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/health|dangling|orphan|uncataloged/i);
  });
});
