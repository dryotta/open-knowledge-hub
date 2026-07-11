import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../test/helpers.js";
import { evaluateCheck } from "../eval/assertions/checks.js";
import type { ToolEvent } from "../eval/copilot.js";

const cleanups: string[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

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

async function okhHomeWith(name: string, module?: string): Promise<string> {
  const home = await makeTempDir(); cleanups.push(home);
  const c = join(home, "containers", name);
  await mkdir(c, { recursive: true });
  if (module) {
    await mkdir(join(c, module, ".okh"), { recursive: true });
    await writeFile(join(c, module, ".okh", "module.yaml"), `type: knowledge\nname: ${module}\ndescription: Test module\n`, "utf8");
  }
  await writeFile(join(home, "registry.json"), JSON.stringify({ version: 1, containers: [{ name, backend: "local", localPath: c, sync: "auto", addedAt: new Date().toISOString() }] }), "utf8");
  return home;
}

describe("evaluateCheck", () => {
  it("tool: passes when the tool was called with matching event", async () => {
    const events = [mkEvent({ tool: "add" }), mkEvent({ tool: "inspect", callId: "c2" })];
    expect((await evaluateCheck({ kind: "tool", name: "add" }, { toolCalls: ["add", "inspect"], toolEvents: events, transcript: "" })).pass).toBe(true);
    expect((await evaluateCheck({ kind: "tool", name: "sync" }, { toolCalls: ["add"], toolEvents: events, transcript: "" })).pass).toBe(false);
  });
  it("tool: fails when tool event has success:false", async () => {
    const events = [mkEvent({ tool: "run", success: false })];
    expect((await evaluateCheck({ kind: "tool", name: "run" }, { toolEvents: events, transcript: "" })).pass).toBe(false);
  });
  it("tool: matches with arguments subset", async () => {
    const events = [mkEvent({ tool: "run", arguments: { module: "wiki", skill: "write" } })];
    expect((await evaluateCheck({ kind: "tool", name: "run", arguments: { module: "wiki" } }, { toolEvents: events, transcript: "" })).pass).toBe(true);
    expect((await evaluateCheck({ kind: "tool", name: "run", arguments: { module: "other" } }, { toolEvents: events, transcript: "" })).pass).toBe(false);
  });
  it("tool: matches with turn constraint", async () => {
    const events = [mkEvent({ tool: "run", turn: 2 })];
    expect((await evaluateCheck({ kind: "tool", name: "run", turn: 2 }, { toolEvents: events, transcript: "" })).pass).toBe(true);
    expect((await evaluateCheck({ kind: "tool", name: "run", turn: 1 }, { toolEvents: events, transcript: "" })).pass).toBe(false);
  });
  it("tool: falls back to toolCalls when no toolEvents provided", async () => {
    expect((await evaluateCheck({ kind: "tool", name: "add" }, { toolCalls: ["add"], transcript: "" })).pass).toBe(true);
    expect((await evaluateCheck({ kind: "tool", name: "sync" }, { toolCalls: ["add"], transcript: "" })).pass).toBe(false);
  });
  it("container: passes for a registered container + module", async () => {
    const okhHome = await okhHomeWith("my-notes", "kb");
    expect((await evaluateCheck({ kind: "container", name: "my-notes", backend: "local", module: "kb" }, { okhHome, transcript: "" })).pass).toBe(true);
    expect((await evaluateCheck({ kind: "container", name: "ghost" }, { okhHome, transcript: "" })).pass).toBe(false);
  });
  it("manifest: passes when the container has discoverable modules", async () => {
    const okhHome = await okhHomeWith("h", "kb");
    expect((await evaluateCheck({ kind: "manifest", name: "h" }, { okhHome, transcript: "" })).pass).toBe(true);
  });
  it("wake-phrase: passes when a non-default phrase is persisted", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    await writeFile(join(home, "preferences.json"), JSON.stringify({ wakePhrase: "brain" }), "utf8");
    expect((await evaluateCheck({ kind: "wake-phrase", default: "hub" }, { okhHome: home, transcript: "" })).pass).toBe(true);
  });
  it("transcript-contains / transcript-absent", async () => {
    expect((await evaluateCheck({ kind: "transcript-contains", pattern: "Plan \\(no changes" }, { transcript: "Plan (no changes made)" })).pass).toBe(true);
    expect((await evaluateCheck({ kind: "transcript-absent", pattern: "error" }, { transcript: "all good" })).pass).toBe(true);
  });
  it("transcript-contains preserves ordered tool dispatches across lines", async () => {
    const check = {
      kind: "transcript-contains" as const,
      pattern: '→ tool: open-knowledge-hub:todos \\{[^\\n]*"operation":"update"[\\s\\S]*→ tool: open-knowledge-hub:todos \\{[^\\n]*"apply":true[\\s\\S]*→ tool: open-knowledge-hub:sync',
    };
    const ordered = [
      '→ tool: open-knowledge-hub:todos {"operation":"update","ref":"r1","completed":true}',
      '→ tool: open-knowledge-hub:todos {"operation":"update","ref":"r1","completed":true,"apply":true}',
      '→ tool: open-knowledge-hub:sync {"container":"kb-hub"}',
    ].join("\n");
    const reversed = [
      '→ tool: open-knowledge-hub:todos {"operation":"update","ref":"r1","completed":true,"apply":true}',
      '→ tool: open-knowledge-hub:todos {"operation":"update","ref":"r1","completed":true}',
      '→ tool: open-knowledge-hub:sync {"container":"kb-hub"}',
    ].join("\n");
    expect((await evaluateCheck(check, { transcript: ordered })).pass).toBe(true);
    expect((await evaluateCheck(check, { transcript: reversed })).pass).toBe(false);
  });

  it("todo-preview-apply passes for a valid preview, apply, and sync sequence", async () => {
    const result = await evaluateCheck(
      { kind: "todo-preview-apply", operation: "update" },
      {
        transcript: "",
        toolEvents: [
          { turn: 1, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true }, completed: true, success: true },
          { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true, apply: true }, completed: true, success: true },
          { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "sync", arguments: { container: "kb-hub" }, completed: true, success: true },
        ],
      } as any,
    );
    expect(result.pass).toBe(true);
  });

  it.each([
    [
      "apply:true occurs on turn 1",
      [
        { turn: 1, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true }, completed: true, success: true },
        { turn: 1, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true, apply: true }, completed: true, success: true },
        { turn: 1, callId: "auto", server: "open-knowledge-hub", tool: "sync", arguments: { container: "kb-hub" }, completed: true, success: true },
      ],
    ],
    [
      "preview missing",
      [
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true, apply: true }, completed: true, success: true },
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "sync", arguments: { container: "kb-hub" }, completed: true, success: true },
      ],
    ],
    [
      "mutation fields differ beyond apply",
      [
        { turn: 1, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true }, completed: true, success: true },
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: false, apply: true }, completed: true, success: true },
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "sync", arguments: { container: "kb-hub" }, completed: true, success: true },
      ],
    ],
    [
      "preview failed",
      [
        { turn: 1, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true }, completed: true, success: false },
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true, apply: true }, completed: true, success: true },
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "sync", arguments: { container: "kb-hub" }, completed: true, success: true },
      ],
    ],
    [
      "apply failed",
      [
        { turn: 1, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true }, completed: true, success: true },
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true, apply: true }, completed: true, success: false },
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "sync", arguments: { container: "kb-hub" }, completed: true, success: true },
      ],
    ],
    [
      "sync missing",
      [
        { turn: 1, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true }, completed: true, success: true },
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true, apply: true }, completed: true, success: true },
      ],
    ],
    [
      "sync failed",
      [
        { turn: 1, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true }, completed: true, success: true },
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true, apply: true }, completed: true, success: true },
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "sync", arguments: { container: "kb-hub" }, completed: true, success: false },
      ],
    ],
    [
      "sync precedes apply",
      [
        { turn: 1, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true }, completed: true, success: true },
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "sync", arguments: { container: "kb-hub" }, completed: true, success: true },
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true, apply: true }, completed: true, success: true },
      ],
    ],
    [
      "early applied matching mutation occurs before the preview/apply pair",
      [
        { turn: 1, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true, apply: true }, completed: true, success: true },
        { turn: 2, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true }, completed: true, success: true },
        { turn: 3, callId: "auto", server: "open-knowledge-hub", tool: "todos", arguments: { operation: "update", ref: "r1", completed: true, apply: true }, completed: true, success: true },
        { turn: 3, callId: "auto", server: "open-knowledge-hub", tool: "sync", arguments: { container: "kb-hub" }, completed: true, success: true },
      ],
    ],
  ])("todo-preview-apply fails when %s", async (_case, toolEvents) => {
    const result = await evaluateCheck(
      { kind: "todo-preview-apply", operation: "update" },
      { transcript: "", toolEvents } as any,
    );
    expect(result.pass).toBe(false);
  });
  it("transcript regex checks fail structurally for an invalid pattern", async () => {
    const result = await evaluateCheck({ kind: "transcript-contains", pattern: "(" }, { transcript: "anything" });
    expect(result.pass).toBe(false);
  });
  it("unknown check kind fails without throwing", async () => {
    const result = await evaluateCheck({ kind: "bogus" } as any, { transcript: "" });
    expect(result.pass).toBe(false);
  });
});
