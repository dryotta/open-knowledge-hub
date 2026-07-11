import { normalizeTodoLabel } from "./serializer.js";
import type { TodoPriority, TodoQuery, TodoRecord } from "./types.js";

const PRIORITY_RANK: Record<TodoPriority, number> = {
  lowest: 0,
  low: 1,
  normal: 2,
  medium: 3,
  high: 4,
  highest: 5,
};

function normalizeQueryLabels(labels: string[] | undefined): string[] {
  if (!labels) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const label of labels) {
    try {
      const value = normalizeTodoLabel(label);
      if (seen.has(value)) continue;
      seen.add(value);
      normalized.push(value);
    } catch {
      continue;
    }
  }
  return normalized;
}

function isOverdue(task: TodoRecord, today: string): boolean {
  return task.status !== "completed" && task.due !== undefined && task.due < today;
}

function sourceCompare(left: TodoRecord["source"], right: TodoRecord["source"]): number {
  if (left.container !== right.container) return left.container.localeCompare(right.container);
  if (left.module !== right.module) return left.module.localeCompare(right.module);
  if (left.path !== right.path) return left.path.localeCompare(right.path);
  return left.line - right.line;
}

export function filterTodos(tasks: TodoRecord[], query: TodoQuery = {}, today: string): TodoRecord[] {
  const labels = normalizeQueryLabels(query.labels);
  const labelMode = query.labelMode ?? "any";
  const priorities = query.priorities ? new Set(query.priorities) : undefined;
  const textQuery = query.query?.trim().toLowerCase();

  return tasks.filter((task) => {
    if (query.container && task.source.container !== query.container) return false;
    if (query.module && task.source.module !== query.module) return false;
    if (query.status && query.status !== "all" && task.status !== query.status) return false;
    if (priorities && !priorities.has(task.priority)) return false;

    if (query.dueAfter) {
      if (!task.due || task.due < query.dueAfter) return false;
    }

    if (query.dueBefore) {
      if (!task.due || task.due > query.dueBefore) return false;
    }

    if (query.overdue !== undefined && isOverdue(task, today) !== query.overdue) return false;

    if (labels.length > 0) {
      const taskLabels = new Set(task.labels.map((label) => normalizeTodoLabel(label)));
      if (labelMode === "all") {
        if (!labels.every((label) => taskLabels.has(label))) return false;
      } else if (!labels.some((label) => taskLabels.has(label))) {
        return false;
      }
    }

    if (textQuery) {
      const haystack = `${task.text}\n${task.labels.join("\n")}`.toLowerCase();
      if (!haystack.includes(textQuery)) return false;
    }

    return true;
  });
}

export function sortTodos(tasks: TodoRecord[], today: string): TodoRecord[] {
  return [...tasks].sort((left, right) => {
    const overdueDelta = Number(isOverdue(right, today)) - Number(isOverdue(left, today));
    if (overdueDelta !== 0) return overdueDelta;

    const leftDue = left.due ?? "9999-12-31";
    const rightDue = right.due ?? "9999-12-31";
    if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);

    const priorityDelta = PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority];
    if (priorityDelta !== 0) return priorityDelta;

    const leftCreated = left.created ?? "";
    const rightCreated = right.created ?? "";
    if (leftCreated !== rightCreated) return rightCreated.localeCompare(leftCreated);

    return sourceCompare(left.source, right.source);
  });
}
