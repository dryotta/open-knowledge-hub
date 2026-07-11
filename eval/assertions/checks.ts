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
  | { kind: "transcript-absent"; pattern: string };

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
  if (opts.backend && entry.backend !== opts.backend) {
    return { pass: false, reason: `backend ${entry.backend} != expected ${opts.backend}` };
  }
  const modules = await discoverModules(entry.localPath);
  if (opts.module && !modules.some((m) => m.path === opts.module)) {
    return { pass: false, reason: `module "${opts.module}" not present` };
  }
  return { pass: true, reason: `container "${opts.name}" registered [${entry.backend}]` };
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
    default:
      return { pass: false, reason: `unknown check kind: ${(check as { kind?: string }).kind ?? "?"}` };
  }
}
