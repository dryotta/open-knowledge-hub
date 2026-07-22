import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { normalize, sep } from "node:path";

// resources/ sits at the package root; ../../ from src/prompts (tsx) and dist/prompts (built) both resolve there.
const PROMPTS_ROOT = new URL("../../resources/prompts/", import.meta.url);

export type TemplateName =
  | "ask"
  | "context"
  | "onboard"
  | "run"
  | "enter"
  | "help"
  | "instructions"
  | "add_module"
  | "dream";

export interface RenderContext {
  /** Caller-provided runtime values; `var:` resolves a slash-path into this. */
  vars?: Record<string, unknown>;
  /** Preferences object; `config:` resolves a slash-path into this. */
  config?: Record<string, unknown>;
}

/** Loads a raw template file (relative to resources/prompts/). */
export type LoadInclude = (relPath: string) => Promise<string>;

const TOKEN = /\{\{\s*([a-z]+):([^}]+?)\s*\}\}/g;

/** Resolve a slash-path (e.g. "skill/name") to a string leaf in obj, or throw. */
export function resolvePath(obj: unknown, path: string): string {
  let cur: unknown = obj;
  for (const seg of path.split("/")) {
    if (cur == null || typeof cur !== "object" || !(seg in (cur as Record<string, unknown>))) {
      throw new Error(`Unresolvable placeholder path "${path}"`);
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (typeof cur === "string" || typeof cur === "number") return String(cur);
  throw new Error(`Placeholder path "${path}" did not resolve to a string`);
}

function withinPrompts(abs: string): boolean {
  const root = normalize(fileURLToPath(PROMPTS_ROOT)).replace(/[\\/]+$/, "");
  const a = normalize(abs);
  return a === root || a.startsWith(root + sep);
}

const cache = new Map<string, string>();

/** Read + cache a template file under resources/prompts/, rejecting path escapes. */
export async function loadPromptFile(relPath: string): Promise<string> {
  const abs = fileURLToPath(new URL(relPath, PROMPTS_ROOT));
  if (!withinPrompts(abs)) throw new Error(`Template path escapes resources/prompts: "${relPath}"`);
  const cached = cache.get(abs);
  if (cached !== undefined) return cached;
  const text = await readFile(abs, "utf8");
  cache.set(abs, text);
  return text;
}

async function resolveToken(
  ns: string,
  arg: string,
  ctx: RenderContext,
  load: LoadInclude,
  seen: Set<string>,
): Promise<string> {
  switch (ns) {
    case "config":
      return resolvePath(ctx.config ?? {}, arg);
    case "var":
      return resolvePath(ctx.vars ?? {}, arg);
    case "prompt": {
      if (seen.has(arg)) throw new Error(`Template include cycle at "${arg}"`);
      const raw = await load(arg);
      return renderString(raw, ctx, load, new Set(seen).add(arg));
    }
    default:
      throw new Error(`Unknown placeholder namespace "${ns}"`);
  }
}

/** Render template text: resolve each {{ns:path}} token. Injected values are not re-scanned. */
export async function renderString(
  text: string,
  ctx: RenderContext = {},
  load: LoadInclude = loadPromptFile,
  seen: Set<string> = new Set(),
): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const [tok, ns, argRaw] = m;
    parts.push(text.slice(last, m.index));
    parts.push(await resolveToken(ns, argRaw.trim(), ctx, load, seen));
    last = (m.index ?? 0) + tok.length;
  }
  parts.push(text.slice(last));
  return parts.join("");
}

/** Load resources/prompts/<name>.md and render it against ctx. */
export async function renderTemplate(name: TemplateName, ctx: RenderContext = {}): Promise<string> {
  const file = `${name}.md`;
  return renderString(await loadPromptFile(file), ctx, loadPromptFile, new Set([file]));
}
