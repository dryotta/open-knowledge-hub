import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ZodRawShape } from "zod";
import { parseFrontmatter } from "../util/frontmatter.js";
import { renderString, type RenderContext } from "../prompts/templates.js";

// resources/ sits at the package root; ../../ from src/server (tsx) and dist/server (built) both resolve there.
const TOOL_META_ROOT = new URL("../../resources/tool-meta/", import.meta.url);

export interface ToolMeta {
  title: string;
  description: string;
  args: Record<string, string>;
}

const cache = new Map<string, string>();

async function readToolMetaFile(name: string): Promise<string> {
  const abs = fileURLToPath(new URL(`${name}.md`, TOOL_META_ROOT));
  const cached = cache.get(abs);
  if (cached !== undefined) return cached;
  const text = await readFile(abs, "utf8");
  cache.set(abs, text);
  return text;
}

/** Parse + validate + render raw tool-meta text (unit-testable without files). */
export async function parseToolMeta(name: string, raw: string, ctx: RenderContext = {}): Promise<ToolMeta> {
  const { data, body } = parseFrontmatter(raw);
  const title = data.title;
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error(`tool-meta "${name}": missing or empty "title"`);
  }
  const argsRaw = data.args ?? {};
  if (typeof argsRaw !== "object" || argsRaw === null || Array.isArray(argsRaw)) {
    throw new Error(`tool-meta "${name}": "args" must be a map`);
  }
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(argsRaw as Record<string, unknown>)) {
    if (typeof v !== "string") throw new Error(`tool-meta "${name}": arg "${k}" description must be a string`);
    args[k] = v;
  }
  const description = (await renderString(body, ctx)).trim();
  if (description.length === 0) throw new Error(`tool-meta "${name}": empty description body`);
  return { title, description, args };
}

/** Load resources/tool-meta/<name>.md and parse/validate/render it. */
export async function loadToolMeta(name: string, ctx?: RenderContext): Promise<ToolMeta> {
  return parseToolMeta(name, await readToolMetaFile(name), ctx);
}

/** Apply arg descriptions to a Zod shape; throw if the shape keys and arg keys differ. */
export function describeShape<S extends ZodRawShape>(shape: S, args: Record<string, string>): S {
  const shapeKeys = Object.keys(shape).sort();
  const argKeys = Object.keys(args).sort();
  if (shapeKeys.length !== argKeys.length || shapeKeys.some((k, i) => k !== argKeys[i])) {
    throw new Error(`tool arg/description mismatch: schema=[${shapeKeys.join(",")}] descriptions=[${argKeys.join(",")}]`);
  }
  const out: Record<string, import("zod").ZodTypeAny> = {};
  for (const [k, schema] of Object.entries(shape)) {
    out[k] = (schema as import("zod").ZodTypeAny).describe(args[k]!);
  }
  return out as unknown as S;
}
