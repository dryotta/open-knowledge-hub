import { parse as parseYaml } from "yaml";

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function isFrontmatterRecord(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => key.length > 0)
  );
}

/** Split a leading YAML frontmatter block from the markdown body. */
export function parseFrontmatter(text: string): Frontmatter {
  const m = FM_RE.exec(text);
  if (!m) return { data: {}, body: text };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]!);
    if (isFrontmatterRecord(parsed)) {
      data = parsed;
    }
  } catch {
    data = {};
  }
  return { data, body: text.slice(m[0].length) };
}

/** Read a string-valued frontmatter field, or undefined if absent/non-string. */
export function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" ? v : undefined;
}
