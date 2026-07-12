import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadRegistry, findContainer } from "../../src/registry/registry.js";
import { discoverModules } from "../../src/modules/discovery.js";
import type { ToolEvent } from "../copilot.js";
import { matchesTool } from "./tool-events.js";

export type Check =
  | { kind: "tool"; name: string; arguments?: Record<string, unknown>; turn?: number }
  | { kind: "container"; name: string; backend?: string; module?: string }
  | { kind: "manifest"; name: string }
  | { kind: "wake-phrase"; default?: string }
  | { kind: "transcript-contains"; pattern: string }
  | { kind: "transcript-absent"; pattern: string }
  | { kind: "todo-apply-sync"; operation: "create" | "update" };

export interface CheckContext {
  okhHome?: string;
  toolCalls?: string[];
  toolEvents?: ToolEvent[];
  transcript: string;
}

export interface CheckResult {
  pass: boolean;
  reason: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isSuccessfulTodoMutation(event: ToolEvent, operation: "create" | "update"): event is ToolEvent & {
  arguments: Record<string, unknown>;
  success: true;
  turn: number;
} {
  const args = asObject(event.arguments);
  return event.server === "open-knowledge-hub" &&
    event.tool === "todos" &&
    event.completed === true &&
    event.success === true &&
    typeof event.turn === "number" &&
    args?.operation === operation;
}

function isSuccessfulSync(event: ToolEvent): event is ToolEvent & { success: true } {
  return event.server === "open-knowledge-hub" && event.tool === "sync" && event.completed === true && event.success === true;
}

export async function checkTodoApplySync(
  ctx: CheckContext,
  operation: "create" | "update",
): Promise<CheckResult> {
  const toolEvents = ctx.toolEvents ?? [];
  const mutations = toolEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => isSuccessfulTodoMutation(event, operation))
    .map(({ event, index }) => ({
      index,
      turn: event.turn as number,
      applied: asObject(event.arguments)?.apply === true,
    }));

  if (mutations.length === 0) {
    return { pass: false, reason: `no successful todos ${operation} events found` };
  }

  const appliedMutations = mutations.filter((m) => m.applied);
  if (appliedMutations.length === 0) {
    return { pass: false, reason: `no applied todos ${operation} found (apply:true required)` };
  }

  if (appliedMutations.length > 1) {
    return {
      pass: false,
      reason: `found ${appliedMutations.length} applied ${operation} mutations; expected exactly one`,
    };
  }

  const apply = appliedMutations[0]!;

  const sync = toolEvents
    .map((event, index) => ({ event, index }))
    .find(({ event, index }) => index > apply.index && isSuccessfulSync(event));
  if (!sync) {
    return { pass: false, reason: `missing successful sync after applied ${operation}` };
  }

  return {
    pass: true,
    reason: `${operation} applied directly with apply:true on turn ${apply.turn}, sync followed`,
  };
}

function pathsFor(okhHome: string) {
  return {
    home: okhHome,
    containersDir: join(okhHome, "containers"),
    registryFile: join(okhHome, "registry.json"),
    preferencesFile: join(okhHome, "preferences.json"),
  };
}

export async function checkContainer(
  okhHome: string | undefined,
  opts: { name?: string; backend?: string; module?: string },
): Promise<CheckResult> {
  if (!opts.name || !okhHome) return { pass: false, reason: "missing container name or okhHome" };
  const entry = findContainer(await loadRegistry(pathsFor(okhHome)), opts.name);
  if (!entry) return { pass: false, reason: `no container "${opts.name}" registered` };
  if (opts.backend && entry.backend.type !== opts.backend) {
    return { pass: false, reason: `backend ${entry.backend.type} != expected ${opts.backend}` };
  }
  const modules = await discoverModules(entry.localPath);
  if (opts.module && !modules.some((m) => m.path === opts.module)) {
    return { pass: false, reason: `module "${opts.module}" not present` };
  }
  return { pass: true, reason: `container "${opts.name}" registered [${entry.backend.type}]` };
}

export async function checkManifest(okhHome: string | undefined, name?: string): Promise<CheckResult> {
  if (!name || !okhHome) return { pass: false, reason: "missing container name or okhHome" };
  const entry = findContainer(await loadRegistry(pathsFor(okhHome)), name);
  if (!entry) return { pass: false, reason: `no container "${name}"` };
  const modules = await discoverModules(entry.localPath);
  if (modules.length === 0) return { pass: false, reason: "no modules discovered" };
  return { pass: true, reason: `discovered ${modules.length} module(s)` };
}

export async function checkWakePhrase(okhHome: string | undefined, def = "hub"): Promise<CheckResult> {
  if (!okhHome) return { pass: false, reason: "missing okhHome" };
  try {
    const prefs = JSON.parse(await readFile(join(okhHome, "preferences.json"), "utf8")) as { wakePhrase?: string };
    if (prefs.wakePhrase && prefs.wakePhrase !== def) {
      return { pass: true, reason: `wake phrase set to "${prefs.wakePhrase}"` };
    }
    return { pass: false, reason: `wake phrase unchanged (${prefs.wakePhrase ?? "none"})` };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { pass: false, reason: "preferences.json not written" };
    return { pass: false, reason: `invalid preferences.json: ${(err as Error).message}` };
  }
}

export async function evaluateCheck(check: Check, ctx: CheckContext): Promise<CheckResult> {
  switch (check.kind) {
    case "tool": {
      const events = ctx.toolEvents;
      if (events && events.length > 0) {
        const exp = { name: check.name, arguments: check.arguments, turn: check.turn };
        const matched = events.some((ev) => matchesTool(ev, exp));
        return { pass: matched, reason: `tool ${check.name} ${matched ? "called" : "not called"}` };
      }
      // Fallback to legacy toolCalls string list when no events
      const called = (ctx.toolCalls ?? []).includes(check.name);
      return { pass: called, reason: `tool ${check.name} ${called ? "called" : "not called"}` };
    }
    case "container":
      return checkContainer(ctx.okhHome, check);
    case "manifest":
      return checkManifest(ctx.okhHome, check.name);
    case "wake-phrase":
      return checkWakePhrase(ctx.okhHome, check.default);
    case "transcript-contains": {
      try {
        const ok = new RegExp(check.pattern, "i").test(ctx.transcript);
        return { pass: ok, reason: ok ? `matched /${check.pattern}/` : `no match /${check.pattern}/` };
      } catch {
        return { pass: false, reason: `bad pattern /${check.pattern}/` };
      }
    }
    case "transcript-absent": {
      try {
        const present = new RegExp(check.pattern, "i").test(ctx.transcript);
        return { pass: !present, reason: present ? `unexpected /${check.pattern}/` : `absent /${check.pattern}/` };
      } catch {
        return { pass: false, reason: `bad pattern /${check.pattern}/` };
      }
    }
    case "todo-apply-sync":
      return checkTodoApplySync(ctx, check.operation);
    default:
      return { pass: false, reason: `unknown check kind: ${(check as { kind?: string }).kind ?? "?"}` };
  }
}
