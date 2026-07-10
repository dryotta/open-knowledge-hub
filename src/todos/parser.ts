import {
  TODO_PRIORITIES,
  type ParsedTodoLine,
  type TodoPriority,
  type TodoStatus,
  type TodoToken,
  type TodoTokenKind,
} from "./types.js";

const LABEL_RE = /#[\p{L}\p{N}_/-]+/gu;
const PRIORITY_RE = /[⏬🔽🔼⏫🔺]/gu;
const DATED_TOKEN_RE = /(📅|➕|✅)\s*(\S+)/gu;
const ID_RE = /🆔\s*(\S+)/gu;

const PRIORITY_BY_EMOJI: Record<string, TodoPriority> = {
  "⏬": "lowest",
  "🔽": "low",
  "🔼": "medium",
  "⏫": "high",
  "🔺": "highest",
};

const DATE_FIELD_BY_EMOJI: Record<string, "due" | "created" | "completed"> = {
  "📅": "due",
  "➕": "created",
  "✅": "completed",
};

function isTodoPriority(value: string): value is TodoPriority {
  return (TODO_PRIORITIES as readonly string[]).includes(value);
}

function isIsoCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseTodoLinePrefix(raw: string): { prefix: string; statusChar: string; statusIndex: number; body: string } | undefined {
  const m = /^(\s*)([-+*]|\d+[.)])(\s+)\[([^\]])\](\s*)(.*)$/.exec(raw);
  if (!m) return undefined;

  const indent = m[1] ?? "";
  const marker = m[2] ?? "";
  const afterMarker = m[3] ?? "";
  const statusChar = m[4] ?? "";
  const afterCheckbox = m[5] ?? "";
  const body = m[6] ?? "";
  const prefix = `${indent}${marker}${afterMarker}[${statusChar}]${afterCheckbox}`;
  const statusIndex = indent.length + marker.length + afterMarker.length + 1;
  return { prefix, statusChar, statusIndex, body };
}

function statusFromChar(statusChar: string): { status: TodoStatus; readOnly: boolean } {
  if (statusChar === " ") return { status: "open", readOnly: false };
  if (statusChar === "x" || statusChar === "X") return { status: "completed", readOnly: false };
  return { status: "custom", readOnly: true };
}

function pushToken(tokens: TodoToken[], token: TodoToken): void {
  tokens.push(token);
}

function collectTokens(body: string): TodoToken[] {
  const tokens: TodoToken[] = [];

  for (const match of body.matchAll(LABEL_RE)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    const value = raw.slice(1);
    pushToken(tokens, {
      kind: "label",
      start,
      end: start + raw.length,
      raw,
      value,
      valid: true,
    });
  }

  for (const match of body.matchAll(PRIORITY_RE)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    const value = PRIORITY_BY_EMOJI[raw];
    if (!value || !isTodoPriority(value)) continue;
    pushToken(tokens, {
      kind: "priority",
      start,
      end: start + raw.length,
      raw,
      value,
      valid: true,
    });
  }

  for (const match of body.matchAll(DATED_TOKEN_RE)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    const emoji = match[1] ?? "";
    const value = match[2] ?? "";
    const kind = DATE_FIELD_BY_EMOJI[emoji];
    if (!kind) continue;
    pushToken(tokens, {
      kind,
      start,
      end: start + raw.length,
      raw,
      value,
      valid: isIsoCalendarDate(value),
    });
  }

  for (const match of body.matchAll(ID_RE)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    const value = match[1] ?? "";
    pushToken(tokens, {
      kind: "id",
      start,
      end: start + raw.length,
      raw,
      value,
      valid: true,
    });
  }

  tokens.sort((a, b) => a.start - b.start || a.end - b.end);
  return tokens;
}

function removeTokenSpans(body: string, tokens: TodoToken[]): string {
  if (tokens.length === 0) return body;

  let result = "";
  let cursor = 0;
  for (const token of tokens) {
    if (token.start < cursor) continue;
    result += body.slice(cursor, token.start);
    cursor = token.end;
  }
  result += body.slice(cursor);
  return result.replace(/\s+/g, " ").trim();
}

function duplicateWarning(kind: TodoTokenKind): string {
  switch (kind) {
    case "priority":
      return "Duplicate priority metadata found; using the last valid value.";
    case "due":
      return "Duplicate due date metadata found; using the last valid value.";
    case "created":
      return "Duplicate created date metadata found; using the last valid value.";
    case "completed":
      return "Duplicate completion date metadata found; using the last valid value.";
    case "id":
      return "Duplicate todo ID metadata found; using the last valid value.";
    case "label":
      return "Duplicate label metadata found; keeping all labels.";
  }
}

function dateWarning(kind: Extract<TodoTokenKind, "due" | "created" | "completed">, value: string): string {
  switch (kind) {
    case "due":
      return `Invalid due date "${value}".`;
    case "created":
      return `Invalid created date "${value}".`;
    case "completed":
      return `Invalid completed date "${value}".`;
  }
}

/**
 * Parse a single Markdown checkbox line into a normalized todo record.
 */
export function parseTodoLine(raw: string): ParsedTodoLine | undefined {
  const parsed = parseTodoLinePrefix(raw);
  if (!parsed) return undefined;

  const { prefix, statusChar, statusIndex, body } = parsed;
  const { status, readOnly } = statusFromChar(statusChar);
  const tokens = collectTokens(body);
  const warnings: string[] = [];
  const labels: string[] = [];
  let priority: TodoPriority = "normal";
  let due: string | undefined;
  let created: string | undefined;
  let completed: string | undefined;
  let id: string | undefined;
  const seen: Partial<Record<TodoTokenKind, number>> = {};

  for (const token of tokens) {
    if (token.kind === "label") {
      if (token.value && token.value.toLowerCase() !== "todo") {
        labels.push(token.value);
      }
      continue;
    }

    if (token.kind === "priority") {
      seen.priority = (seen.priority ?? 0) + 1;
      if (seen.priority > 1) warnings.push(duplicateWarning(token.kind));
      if (token.valid && token.value && isTodoPriority(token.value)) priority = token.value;
      continue;
    }

    if (token.kind === "due" || token.kind === "created" || token.kind === "completed") {
      seen[token.kind] = (seen[token.kind] ?? 0) + 1;
      if (seen[token.kind]! > 1) warnings.push(duplicateWarning(token.kind));
      if (!token.valid) {
        warnings.push(dateWarning(token.kind, token.value ?? ""));
        continue;
      }
      if (token.value) {
        if (token.kind === "due") due = token.value;
        if (token.kind === "created") created = token.value;
        if (token.kind === "completed") completed = token.value;
      }
      continue;
    }

    if (token.kind === "id") {
      seen.id = (seen.id ?? 0) + 1;
      if (seen.id > 1) warnings.push(duplicateWarning(token.kind));
      if (token.valid && token.value) id = token.value;
    }
  }

  const text = removeTokenSpans(body, tokens);

  return {
    raw,
    prefix,
    statusIndex,
    statusChar,
    status,
    readOnly,
    body,
    text,
    labels,
    priority,
    due,
    created,
    completed,
    id,
    warnings,
    tokens,
  };
}
