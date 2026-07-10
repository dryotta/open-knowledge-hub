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

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/u.test(char);
}

function tokenRemovalRange(body: string, token: TodoToken): { start: number; end: number } {
  let start = token.start;
  let end = token.end;

  if (isWhitespace(body[start - 1])) {
    start--;
  } else if (isWhitespace(body[end])) {
    end++;
  }

  return { start, end };
}

function removeTokenSpans(body: string, tokens: TodoToken[]): string {
  if (tokens.length === 0) return body;

  const removedRanges = tokens
    .map((token) => tokenRemovalRange(body, token))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const mergedRanges: Array<{ start: number; end: number }> = [];
  for (const range of removedRanges) {
    const previous = mergedRanges[mergedRanges.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    mergedRanges.push({ ...range });
  }

  let text = "";
  let cursor = 0;
  for (const range of mergedRanges) {
    text += body.slice(cursor, range.start);
    cursor = range.end;
  }
  return text + body.slice(cursor);
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

function replacePatchedTokens(
  parsed: ParsedTodoLine,
  tokens: TodoToken[],
  segment: string,
  statusChar = parsed.statusChar,
): ParsedTodoLine {
  const [first, ...rest] = tokens;
  if (!first) {
    return parsed;
  }

  let body = `${parsed.body.slice(0, first.start)}${segment}${parsed.body.slice(first.end)}`;
  if (rest.length > 0) {
    const delta = segment.length - (first.end - first.start);
    body = removeTokenSpans(body, rest.map((token) => ({
      ...token,
      start: token.start + delta,
      end: token.end + delta,
    })));
  }

  return reparsedLine(parsed, body, statusChar);
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
  const priorityTokens = parsed.tokens.filter((token) => token.kind === "priority");
  const withoutPriority = reparsedLine(parsed, removeTokenSpans(parsed.body, priorityTokens));

  if (priority === null || priority === "normal") return withoutPriority;

  const emoji = PRIORITY_EMOJI_BY_VALUE[priority];
  if (priorityTokens.length > 0) {
    return replacePatchedTokens(parsed, priorityTokens, emoji);
  }

  const insertAt = firstTokenIndex(withoutPriority, ["due", "created", "completed", "id"]);
  return reparsedLine(withoutPriority, insertSegment(withoutPriority.body, insertAt, emoji));
}

function applyDuePatch(parsed: ParsedTodoLine, due: string | null): ParsedTodoLine {
  const dueTokens = parsed.tokens.filter((token) => token.kind === "due");
  const withoutDue = reparsedLine(parsed, removeTokenSpans(parsed.body, dueTokens));

  if (due === null) return withoutDue;

  assertIsoCalendarDate(due, "due date");
  if (dueTokens.length > 0) {
    return replacePatchedTokens(parsed, dueTokens, `📅 ${due}`);
  }

  const insertAt = firstTokenIndex(withoutDue, ["created", "completed", "id"]);
  return reparsedLine(withoutDue, insertSegment(withoutDue.body, insertAt, `📅 ${due}`));
}

function applyCompletedPatch(parsed: ParsedTodoLine, completed: boolean, today: string): ParsedTodoLine {
  assertIsoCalendarDate(today, "completion date");
  const statusChar = completed ? "x" : " ";
  const completedTokens = parsed.tokens.filter((token) => token.kind === "completed");
  const withoutCompleted = reparsedLine(parsed, removeTokenSpans(parsed.body, completedTokens), statusChar);

  if (!completed) return withoutCompleted;

  if (completedTokens.length > 0) {
    return replacePatchedTokens(parsed, completedTokens, `✅ ${today}`, statusChar);
  }

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
