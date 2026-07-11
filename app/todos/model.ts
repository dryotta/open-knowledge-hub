import { filterTodos, sortTodos } from "../../src/todos/query.js";
import type { TodoPriority, TodoRecord, TodoStatus } from "../../src/todos/types.js";

export interface AppFilters {
  status: TodoStatus | "all";
  labels: string[];
  source: string;
  priorities: TodoPriority[];
  due: "all" | "overdue" | "today" | "upcoming" | "none";
  dueFrom: string;
  dueTo: string;
  query: string;
}

export function applyAppFilters(tasks: TodoRecord[], filters: AppFilters, today: string): TodoRecord[] {
  const dueFiltered = tasks.filter((task) => {
    if (filters.source && `${task.source.container}/${task.source.module}` !== filters.source) return false;
    if (filters.due === "overdue") return task.status === "open" && task.due !== undefined && task.due < today;
    if (filters.due === "today") return task.due === today;
    if (filters.due === "upcoming") return task.due !== undefined && task.due > today;
    if (filters.due === "none") return task.due === undefined;
    return true;
  });

  return sortTodos(
    filterTodos(
      dueFiltered,
      {
        status: filters.status,
        labels: filters.labels.length > 0 ? filters.labels : undefined,
        labelMode: "any",
        priorities: filters.priorities.length > 0 ? filters.priorities : undefined,
        dueAfter: filters.dueFrom || undefined,
        dueBefore: filters.dueTo || undefined,
        query: filters.query,
      },
      today,
    ),
    today,
  );
}

export function mergeRefreshedTasks(
  existing: TodoRecord[],
  refreshed: TodoRecord[],
  expectedRef?: string,
): TodoRecord[] | null {
  const refreshedByRef = new Map(refreshed.map((task) => [task.ref, task]));
  if (expectedRef !== undefined && !refreshedByRef.has(expectedRef)) {
    return null;
  }

  const seen = new Set<string>();
  const merged = existing.map((task) => {
    const next = refreshedByRef.get(task.ref) ?? task;
    seen.add(next.ref);
    return next;
  });

  for (const task of refreshed) {
    if (!seen.has(task.ref)) merged.push(task);
  }

  return merged;
}
