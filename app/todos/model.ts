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

/**
 * Decide whether the app is allowed to apply todo updates in the current host.
 *
 * Toggling a checkbox proxies a `tools/call` back to the MCP server via the
 * host. That only works when the host advertises the `serverTools` capability
 * ("Host can proxy tool calls to the MCP server") in its `ui/initialize`
 * response. When the host advertises capabilities but omits `serverTools`, the
 * proxied call never completes, so updates must be disabled up front.
 *
 * When capabilities are unknown (`undefined`), stay optimistic and let the
 * per-call timeout surface a hung update instead of pre-emptively disabling.
 */
export function canApplyUpdates(hostCapabilities: unknown): boolean {
  if (hostCapabilities === undefined || hostCapabilities === null) return true;
  if (typeof hostCapabilities !== "object") return true;
  const serverTools = (hostCapabilities as Record<string, unknown>).serverTools;
  return serverTools !== undefined && serverTools !== null && serverTools !== false;
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
