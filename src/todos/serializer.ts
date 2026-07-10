import { parseTodoLine } from "./parser.js";
import type { CreateTodoLineInput, ParsedTodoLine, TodoLinePatch, TodoPriority, TodoToken } from "./types.js";

const LABEL_RE = /^[\p{L}\p{N}_/-]+$/u;

const PRIORITY_EMOJI_BY_VALUE: Record<TodoPriority, string> = {
  lowest: "⏬",
  low: "🔽",
  normal: "",
  medium: "🔼",
  high: "⏫",
  highest: "🔺",
};

const CLOSE_PUNCTUATION = new Set([",", ".", "!", "?", ";", ":", ")", "]", "}", ">", "”", "’", "»", "›", "）", "】", "」", "』", "》", "〕"]);
const UNICODE_PUNCTUATION_RE = /^\p{P}$/u;
const UNICODE_OPEN_OR_INITIAL_PUNCTUATION_RE = /^[\p{Ps}\p{Pi}]$/u;

function firstCodePoint(text: string): string | undefined {
  for (const char of text) return char;
  return undefined;
}

function lastCodePoint(text: string): string | undefined {
  let last: string | undefined;
  for (const char of text) last = char;
  return last;
}

function shouldInsertSpace(left: string, right: string): boolean {
  const leftBoundary = lastCodePoint(left.trimEnd());
  const rightBoundary = firstCodePoint(right.trimStart());
  if (!leftBoundary || !rightBoundary) return false;
  if (/^\s/u.test(right)) return false;
  if (UNICODE_OPEN_OR_INITIAL_PUNCTUATION_RE.test(leftBoundary)) return false;
  if (UNICODE_PUNCTUATION_RE.test(rightBoundary)) return false;
  return true;
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

function assertIsoCalendarDate(value: string, field: string): void {
  if (!isIsoCalendarDate(value)) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
}

function assertNonBlankText(text: string): string {
  const normalized = text.trim();
  if (normalized.length === 0) {
    throw new Error("Todo text cannot be blank.");
  }
  return normalized;
}

function isReservedTodoLabel(token: TodoToken): boolean {
  return token.kind === "label" && (token.value?.toLowerCase() ?? "") === "todo";
}

function removeTokenSpans(body: string, tokens: TodoToken[]): string {
  if (tokens.length === 0) return body.trim();

  const removedRanges: Array<{ start: number; end: number }> = [];
  for (const token of tokens) {
    let start = token.start;
    let end = token.end;
    if (start > 0 && /\s/u.test(body[start - 1]!)) {
      while (start > 0 && /\s/u.test(body[start - 1]!)) start--;
    } else if (start === 0 || !/\s/u.test(body[start - 1] ?? "")) {
      while (end < body.length && /\s/u.test(body[end]!)) end++;
    }
    removedRanges.push({ start, end });
  }

  removedRanges.sort((a, b) => a.start - b.start || a.end - b.end);

  const pieces: string[] = [];
  let cursor = 0;
  for (const range of removedRanges) {
    pieces.push(body.slice(cursor, range.start));
    cursor = range.end;
  }
  pieces.push(body.slice(cursor));

  let text = "";
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    if (text.length > 0 && shouldInsertSpace(text, piece)) {
      text += " ";
    }
    text += piece;
  }

  return text.trim();
}

function insertSegment(body: string, index: number, segment: string): string {
  const left = body.slice(0, index);
  const right = body.slice(index);
  let insertion = segment;

  const leftBoundary = lastCodePoint(left.trimEnd());
  if (
    leftBoundary &&
    !/\s/u.test(left[left.length - 1] ?? "") &&
    !UNICODE_OPEN_OR_INITIAL_PUNCTUATION_RE.test(leftBoundary)
  ) {
    insertion = ` ${insertion}`;
  }

  const rightBoundary = firstCodePoint(right.trimStart());
  if (
    rightBoundary &&
    !/^\s/u.test(right) &&
    !CLOSE_PUNCTUATION.has(rightBoundary)
  ) {
    insertion = `${insertion} `;
  }

  return `${left}${insertion}${right}`;
}

function normalizedCategoryLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const label of labels) {
    const value = normalizeTodoLabel(label);
    if (value === "todo" || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function rebuildLine(parsed: ParsedTodoLine, body: string, statusChar = parsed.statusChar): string {
  const prefix = `${parsed.prefix.slice(0, parsed.statusIndex)}${statusChar}${parsed.prefix.slice(parsed.statusIndex + parsed.statusChar.length)}`;
  return `${prefix}${body}`;
}

function reparsedLine(parsed: ParsedTodoLine, body: string, statusChar = parsed.statusChar): ParsedTodoLine {
  const next = parseTodoLine(rebuildLine(parsed, body, statusChar));
  if (!next) {
    throw new Error("Patched todo line is invalid.");
  }
  return next;
}

function firstTokenIndex(parsed: ParsedTodoLine, kinds: readonly TodoToken["kind"][]): number {
  const token = parsed.tokens.find((candidate) => kinds.includes(candidate.kind));
  return token?.start ?? parsed.body.length;
}

function applyLabelPatch(parsed: ParsedTodoLine, labels: string[]): ParsedTodoLine {
  const nextLabels = normalizedCategoryLabels(labels);
  const removable = parsed.tokens.filter((token) => token.kind === "label" && !isReservedTodoLabel(token));
  const withoutLabels = reparsedLine(parsed, removeTokenSpans(parsed.body, removable));

  if (nextLabels.length === 0) return withoutLabels;

  const todoMarkers = withoutLabels.tokens.filter(isReservedTodoLabel);
  const insertAt = todoMarkers.length > 0
    ? todoMarkers[todoMarkers.length - 1]!.end
    : firstTokenIndex(withoutLabels, ["priority", "due", "created", "completed", "id"]);
  const segment = nextLabels.map((label) => `#${label}`).join(" ");
  return reparsedLine(withoutLabels, insertSegment(withoutLabels.body, insertAt, segment));
}

function applyPriorityPatch(parsed: ParsedTodoLine, priority: TodoPriority | null): ParsedTodoLine {
  const withoutPriority = reparsedLine(
    parsed,
    removeTokenSpans(parsed.body, parsed.tokens.filter((token) => token.kind === "priority")),
  );

  if (priority === null || priority === "normal") return withoutPriority;

  const emoji = PRIORITY_EMOJI_BY_VALUE[priority];
  const insertAt = firstTokenIndex(withoutPriority, ["due", "created", "completed", "id"]);
  return reparsedLine(withoutPriority, insertSegment(withoutPriority.body, insertAt, emoji));
}

function applyDuePatch(parsed: ParsedTodoLine, due: string | null): ParsedTodoLine {
  const withoutDue = reparsedLine(
    parsed,
    removeTokenSpans(parsed.body, parsed.tokens.filter((token) => token.kind === "due")),
  );

  if (due === null) return withoutDue;

  assertIsoCalendarDate(due, "due date");
  const insertAt = firstTokenIndex(withoutDue, ["created", "completed", "id"]);
  return reparsedLine(withoutDue, insertSegment(withoutDue.body, insertAt, `📅 ${due}`));
}

function applyCompletedPatch(parsed: ParsedTodoLine, completed: boolean, today: string): ParsedTodoLine {
  assertIsoCalendarDate(today, "completion date");
  const statusChar = completed ? "x" : " ";
  const withoutCompleted = reparsedLine(
    parsed,
    removeTokenSpans(parsed.body, parsed.tokens.filter((token) => token.kind === "completed")),
    statusChar,
  );

  if (!completed) return withoutCompleted;

  const insertAt = firstTokenIndex(withoutCompleted, ["id"]);
  return reparsedLine(
    withoutCompleted,
    insertSegment(withoutCompleted.body, insertAt, `✅ ${today}`),
    statusChar,
  );
}

export function normalizeTodoLabel(label: string): string {
  const stripped = label.trim().replace(/^#+/u, "").toLowerCase();
  if (stripped.length === 0 || !LABEL_RE.test(stripped)) {
    throw new Error(`Invalid todo label: ${label}`);
  }
  return stripped;
}

export function createTodoLine(input: CreateTodoLineInput): string {
  const text = assertNonBlankText(input.text);
  const labels = normalizedCategoryLabels(input.labels);
  assertIsoCalendarDate(input.created, "created date");
  if (input.due !== undefined) {
    assertIsoCalendarDate(input.due, "due date");
  }

  const body = [
    text,
    "#todo",
    ...labels.map((label) => `#${label}`),
    PRIORITY_EMOJI_BY_VALUE[input.priority ?? "normal"],
    input.due ? `📅 ${input.due}` : "",
    `➕ ${input.created}`,
  ].filter((part) => part.length > 0).join(" ");

  return `- [ ] ${body}`;
}

export function patchTodoLine(parsed: ParsedTodoLine, patch: TodoLinePatch, today: string): string {
  if (parsed.readOnly) {
    throw new Error("Cannot patch read-only todo statuses.");
  }

  const hasChange = patch.completed !== undefined ||
    patch.labels !== undefined ||
    patch.due !== undefined ||
    patch.priority !== undefined;
  if (!hasChange) {
    throw new Error("Todo patch cannot be empty.");
  }

  let next = parsed;

  if (patch.labels !== undefined) {
    next = applyLabelPatch(next, patch.labels);
  }

  if (patch.priority !== undefined) {
    next = applyPriorityPatch(next, patch.priority);
  }

  if (patch.due !== undefined) {
    next = applyDuePatch(next, patch.due);
  }

  if (patch.completed !== undefined) {
    next = applyCompletedPatch(next, patch.completed, today);
  }

  return next.raw;
}
