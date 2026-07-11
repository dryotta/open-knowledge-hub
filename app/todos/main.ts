import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { applyAppFilters, mergeRefreshedTasks, type AppFilters } from "./model.js";
import {
  TODO_PRIORITIES,
  type TodoListResult,
  type TodoMutationResult,
  type TodoPriority,
  type TodoRecord,
  type TodoSource,
  type TodoWarning,
} from "../../src/todos/types.js";

const filtersNode = document.getElementById("filters");
const listNode = document.getElementById("todo-list");
const statusNode = document.getElementById("status-message");
const errorNode = document.getElementById("error-banner");
const unsyncedNode = document.getElementById("unsynced-banner");
const warningNode = document.getElementById("warning-banner");

if (
  !(filtersNode instanceof HTMLElement)
  || !(listNode instanceof HTMLUListElement)
  || !(statusNode instanceof HTMLElement)
  || !(errorNode instanceof HTMLElement)
  || !(unsyncedNode instanceof HTMLElement)
  || !(warningNode instanceof HTMLElement)
) {
  throw new Error("Todo app HTML is missing required elements.");
}

const filtersElement = filtersNode;
const listElement = listNode;
const statusElement = statusNode;
const errorBanner = errorNode;
const unsyncedBanner = unsyncedNode;
const warningBanner = warningNode;

const app = new App({ name: "Open Knowledge Hub Todos", version: "0.2.0" });
const dirtyContainers = new Set<string>();
const pendingRefs = new Set<string>();
const filters: AppFilters = {
  status: "all",
  labels: [],
  source: "",
  priorities: [],
  due: "all",
  dueFrom: "",
  dueTo: "",
  query: "",
};

let tasks: TodoRecord[] = [];
let warnings: TodoWarning[] = [];
let errorMessage = "";
let receivedInitialResult = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isTodoPriority(value: unknown): value is TodoPriority {
  return typeof value === "string" && TODO_PRIORITIES.some((priority) => priority === value);
}

function isTodoSource(value: unknown): value is TodoSource {
  return isRecord(value)
    && typeof value.container === "string"
    && typeof value.module === "string"
    && typeof value.path === "string"
    && typeof value.line === "number";
}

function isTodoRecord(value: unknown): value is TodoRecord {
  return isRecord(value)
    && typeof value.ref === "string"
    && (value.status === "open" || value.status === "completed" || value.status === "custom")
    && typeof value.statusChar === "string"
    && typeof value.readOnly === "boolean"
    && typeof value.text === "string"
    && Array.isArray(value.labels)
    && value.labels.every((label) => typeof label === "string")
    && isTodoPriority(value.priority)
    && isOptionalString(value.due)
    && isOptionalString(value.created)
    && isOptionalString(value.completed)
    && isOptionalString(value.id)
    && Array.isArray(value.warnings)
    && value.warnings.every((warning) => typeof warning === "string")
    && isTodoSource(value.source);
}

function isTodoWarning(value: unknown): value is TodoWarning {
  return isRecord(value) && isTodoSource(value.source) && typeof value.message === "string";
}

function isTodoListResult(value: unknown): value is TodoListResult {
  if (!isRecord(value) || !Array.isArray(value.tasks) || !Array.isArray(value.warnings) || !isRecord(value.counts)) {
    return false;
  }
  return value.tasks.every(isTodoRecord)
    && value.warnings.every(isTodoWarning)
    && typeof value.counts.total === "number"
    && typeof value.counts.open === "number"
    && typeof value.counts.completed === "number"
    && typeof value.counts.custom === "number";
}

type AppliedTodoMutationResult = Extract<TodoMutationResult, { applied: true }>;

function isAppliedTodoMutationResult(value: unknown): value is AppliedTodoMutationResult {
  return isRecord(value) && isTodoRecord(value.todo) && typeof value.dirtyContainer === "string";
}

function todayString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function selected(condition: boolean): string {
  return condition ? " selected" : "";
}

function checked(condition: boolean): string {
  return condition ? " checked" : "";
}

function disabled(condition: boolean): string {
  return condition ? " disabled" : "";
}

function sourceName(task: TodoRecord): string {
  return `${task.source.container}/${task.source.module}`;
}

function availableLabels(): string[] {
  return [...new Set(tasks.flatMap((task) => task.labels))].sort((left, right) => left.localeCompare(right));
}

function availableSources(): string[] {
  return [...new Set(tasks.map(sourceName))].sort((left, right) => left.localeCompare(right));
}

function availablePriorities(): TodoPriority[] {
  const present = new Set(tasks.map((task) => task.priority));
  return TODO_PRIORITIES.filter((priority) => present.has(priority));
}

function keepFiltersCoherent(): void {
  const labels = new Set(availableLabels());
  const sources = new Set(availableSources());
  const priorities = new Set(availablePriorities());
  filters.labels = filters.labels.filter((label) => labels.has(label));
  filters.priorities = filters.priorities.filter((priority) => priorities.has(priority));
  if (filters.source && !sources.has(filters.source)) filters.source = "";
}

function renderFilters(): void {
  const counts = {
    all: tasks.length,
    open: tasks.filter((task) => task.status === "open").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    custom: tasks.filter((task) => task.status === "custom").length,
  };
  const statusButtons = (["all", "open", "completed", "custom"] as const)
    .map((status) => {
      const label = status[0]!.toUpperCase() + status.slice(1);
      return `<button class="status-button" type="button" data-status="${status}" aria-pressed="${filters.status === status}">${label} <span aria-hidden="true">${counts[status]}</span></button>`;
    })
    .join("");
  const labels = availableLabels();
  const labelChips = labels.length === 0
    ? '<span class="status-message">No labels</span>'
    : labels.map((label) => `<button class="chip" type="button" data-label="${escapeHtml(label)}" aria-pressed="${filters.labels.includes(label)}">#${escapeHtml(label)}</button>`).join("");
  const sourceOptions = availableSources()
    .map((source) => `<option value="${escapeHtml(source)}"${selected(filters.source === source)}>${escapeHtml(source)}</option>`)
    .join("");
  const priorityOptions = availablePriorities()
    .map((priority) => `<option value="${priority}"${selected(filters.priorities.includes(priority))}>${priority}</option>`)
    .join("");

  filtersElement.innerHTML = `
    <div class="status-buttons" role="group" aria-label="Status">${statusButtons}</div>
    <div>
      <span class="field">Labels (match any)</span>
      <div class="label-chips">${labelChips}</div>
    </div>
    <div class="filter-grid">
      <label class="field">Source
        <select id="source-filter">
          <option value="">All sources</option>
          ${sourceOptions}
        </select>
      </label>
      <label class="field">Priorities
        <select id="priority-filter" multiple size="3" aria-describedby="priority-help">
          ${priorityOptions}
        </select>
        <span id="priority-help">Use Ctrl or Command to select more than one.</span>
      </label>
      <label class="field">Due
        <select id="due-filter">
          <option value="all"${selected(filters.due === "all")}>All dates</option>
          <option value="overdue"${selected(filters.due === "overdue")}>Overdue</option>
          <option value="today"${selected(filters.due === "today")}>Today</option>
          <option value="upcoming"${selected(filters.due === "upcoming")}>Upcoming</option>
          <option value="none"${selected(filters.due === "none")}>No due date</option>
        </select>
      </label>
      <label class="field">Due from
        <input id="due-from-filter" type="date" value="${escapeHtml(filters.dueFrom)}">
      </label>
      <label class="field">Due to
        <input id="due-to-filter" type="date" value="${escapeHtml(filters.dueTo)}">
      </label>
      <label class="field field-search">Search
        <input id="query-filter" type="search" value="${escapeHtml(filters.query)}" placeholder="Task text or label">
      </label>
      <button class="clear-button" type="button" data-action="clear-filters">Clear filters</button>
    </div>
  `;
}

function renderBanners(): void {
  errorBanner.hidden = errorMessage.length === 0;
  errorBanner.textContent = errorMessage;

  const dirty = [...dirtyContainers].sort((left, right) => left.localeCompare(right));
  unsyncedBanner.hidden = dirty.length === 0;
  unsyncedBanner.textContent = dirty.length === 0
    ? ""
    : `Local changes are not synced: ${dirty.join(", ")}. Use the sync tool when you are ready.`;

  warningBanner.hidden = warnings.length === 0;
  warningBanner.innerHTML = warnings.length === 0
    ? ""
    : `<strong>${warnings.length} scan warning${warnings.length === 1 ? "" : "s"}</strong><ul>${warnings.map((warning) => `<li>${escapeHtml(warning.source.container)}/${escapeHtml(warning.source.module)} · ${escapeHtml(warning.source.path)}:${warning.source.line} — ${escapeHtml(warning.message)}</li>`).join("")}</ul>`;
}

function renderList(): void {
  const filtered = applyAppFilters(tasks, filters, todayString());
  statusElement.textContent = receivedInitialResult
    ? `${filtered.length} of ${tasks.length} task${tasks.length === 1 ? "" : "s"} shown`
    : "Waiting for todo data…";

  if (filtered.length === 0) {
    listElement.innerHTML = `<li class="empty">${receivedInitialResult ? "No todos match the current filters." : "Waiting for the initial todos result…"}</li>`;
    return;
  }

  listElement.innerHTML = filtered.map((task) => {
    const pending = pendingRefs.has(task.ref);
    const readOnly = task.readOnly || task.status === "custom";
    const taskWarnings = [
      ...task.warnings,
      ...(readOnly ? ["This marker is read-only and cannot be completed here."] : []),
    ];
    const labels = task.labels.map((label) => `<span class="badge">#${escapeHtml(label)}</span>`).join("");
    const warningsMarkup = taskWarnings.map((warning) => `<div class="task-warning">⚠ ${escapeHtml(warning)}</div>`).join("");
    const due = task.due ? `<span>Due ${escapeHtml(task.due)}</span>` : "<span>No due date</span>";
    const completedClass = task.status === "completed" ? " completed" : "";
    const pendingClass = pending ? " pending" : "";
    return `
      <li class="todo-row${completedClass}${pendingClass}">
        <input
          class="todo-check"
          type="checkbox"
          data-ref="${escapeHtml(task.ref)}"
          aria-label="${task.status === "completed" ? "Reopen" : "Complete"} ${escapeHtml(task.text)}"
          ${checked(task.status === "completed")}
          ${disabled(readOnly || pending)}
        >
        <div class="todo-main">
          <div class="todo-title">${escapeHtml(task.text)}</div>
          <div class="todo-meta">
            <span>${escapeHtml(sourceName(task))} · ${escapeHtml(task.source.path)}:${task.source.line}</span>
            <span class="badge priority-${task.priority}">${escapeHtml(task.priority)}</span>
            ${due}
            ${labels}
            ${pending ? "<span>Updating…</span>" : ""}
          </div>
          ${warningsMarkup}
        </div>
      </li>
    `;
  }).join("");
}

function render(): void {
  keepFiltersCoherent();
  renderFilters();
  renderBanners();
  renderList();
}

function replaceList(result: TodoListResult): void {
  tasks = [...result.tasks];
  warnings = [...result.warnings];
  receivedInitialResult = true;
}

function resultText(result: CallToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
}

function failureMessage(prefix: string, result?: CallToolResult): string {
  const detail = result ? resultText(result) : "";
  return detail ? `${prefix}: ${detail}` : prefix;
}

function refreshArgsFromFilters(): Record<string, unknown> {
  const args: Record<string, unknown> = { operation: "list" };
  const trimmedQuery = filters.query.trim();
  if (filters.status !== "all") args.status = filters.status;
  if (filters.labels.length > 0) args.labels = [...filters.labels];
  if (filters.priorities.length > 0) args.priorities = [...filters.priorities];
  if (filters.dueFrom) args.dueAfter = filters.dueFrom;
  if (filters.dueTo) args.dueBefore = filters.dueTo;
  if (trimmedQuery) args.query = trimmedQuery;

  if (filters.source) {
    const slash = filters.source.indexOf("/");
    if (slash > 0 && slash < filters.source.length - 1) {
      args.container = filters.source.slice(0, slash);
      args.module = filters.source.slice(slash + 1);
    }
  }

  const today = todayString();
  if (filters.due === "overdue") {
    args.overdue = true;
  } else if (filters.due === "today") {
    args.dueAfter = today;
    args.dueBefore = today;
  } else if (filters.due === "upcoming") {
    const tomorrow = new Date(`${today}T00:00:00.000Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    args.dueAfter = tomorrow.toISOString().slice(0, 10);
  }

  return args;
}

async function refreshAfterFailure(message: string, expectedRef?: string): Promise<void> {
  try {
    const refresh = await app.callServerTool({ name: "todos", arguments: refreshArgsFromFilters() });
    if (refresh.isError) {
      errorMessage = `${message} Refresh failed: ${resultText(refresh) || "the todos tool returned an error."}`;
    } else if (!isTodoListResult(refresh.structuredContent)) {
      errorMessage = `${message} Refresh failed because the todos result was malformed.`;
    } else {
      const merged = mergeRefreshedTasks(tasks, refresh.structuredContent.tasks, expectedRef);
      if (merged === null) {
        const fullRefresh = await app.callServerTool({ name: "todos", arguments: { operation: "list" } });
        if (fullRefresh.isError) {
          errorMessage = `${message} Refresh failed: ${resultText(fullRefresh) || "the todos tool returned an error."}`;
        } else if (!isTodoListResult(fullRefresh.structuredContent)) {
          errorMessage = `${message} Refresh failed because the todos result was malformed.`;
        } else {
          replaceList(fullRefresh.structuredContent);
          errorMessage = `${message} The list was refreshed.`;
        }
      } else {
        tasks = merged;
        warnings = [...refresh.structuredContent.warnings];
        receivedInitialResult = true;
        errorMessage = `${message} The list was refreshed.`;
      }
    }
  } catch (error: unknown) {
    errorMessage = `${message} Refresh failed: ${error instanceof Error ? error.message : "transport error."}`;
  }
  render();
}

async function toggleTodo(ref: string, completed: boolean): Promise<void> {
  const current = tasks.find((task) => task.ref === ref);
  if (!current || current.readOnly || current.status === "custom" || pendingRefs.has(ref)) return;

  pendingRefs.add(ref);
  errorMessage = "";
  render();

  try {
    const result = await app.callServerTool({
      name: "todos",
      arguments: { operation: "update", ref, completed, apply: true },
    });
    if (result.isError) {
      pendingRefs.delete(ref);
      const message = failureMessage("Could not update the todo", result);
      errorMessage = message;
      render();
      await refreshAfterFailure(message, ref);
      return;
    }
    if (!isAppliedTodoMutationResult(result.structuredContent)) {
      pendingRefs.delete(ref);
      const message = "Could not update the todo because the tool result was malformed.";
      errorMessage = message;
      render();
      await refreshAfterFailure(message, ref);
      return;
    }

    const index = tasks.findIndex((task) => task.ref === ref);
    if (index >= 0) tasks[index] = result.structuredContent.todo;
    dirtyContainers.add(result.structuredContent.dirtyContainer);
    pendingRefs.delete(ref);
    errorMessage = "";
    render();
  } catch (error: unknown) {
    pendingRefs.delete(ref);
    const message = `Could not update the todo: ${error instanceof Error ? error.message : "transport error."}`;
    errorMessage = message;
    render();
    await refreshAfterFailure(message, ref);
  }
}

filtersElement.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const control = event.target.closest<HTMLElement>("[data-status], [data-label], [data-action]");
  if (!control) return;

  const status = control.dataset.status;
  if (status === "all" || status === "open" || status === "completed" || status === "custom") {
    filters.status = status;
  }

  const label = control.dataset.label;
  if (label !== undefined) {
    filters.labels = filters.labels.includes(label)
      ? filters.labels.filter((selectedLabel) => selectedLabel !== label)
      : [...filters.labels, label];
  }

  if (control.dataset.action === "clear-filters") {
    filters.status = "all";
    filters.labels = [];
    filters.source = "";
    filters.priorities = [];
    filters.due = "all";
    filters.dueFrom = "";
    filters.dueTo = "";
    filters.query = "";
  }

  render();
});

filtersElement.addEventListener("change", (event) => {
  const control = event.target;
  if (control instanceof HTMLSelectElement && control.id === "source-filter") {
    filters.source = control.value;
  } else if (control instanceof HTMLSelectElement && control.id === "priority-filter") {
    filters.priorities = Array.from(control.selectedOptions, (option) => option.value).filter(isTodoPriority);
  } else if (control instanceof HTMLSelectElement && control.id === "due-filter") {
    const value = control.value;
    if (value === "all" || value === "overdue" || value === "today" || value === "upcoming" || value === "none") {
      filters.due = value;
    }
  } else if (control instanceof HTMLInputElement && control.id === "due-from-filter") {
    filters.dueFrom = control.value;
  } else if (control instanceof HTMLInputElement && control.id === "due-to-filter") {
    filters.dueTo = control.value;
  }
  render();
});

filtersElement.addEventListener("input", (event) => {
  const control = event.target;
  if (control instanceof HTMLInputElement && control.id === "query-filter") {
    filters.query = control.value;
    renderList();
  }
});

listElement.addEventListener("change", (event) => {
  const control = event.target;
  if (!(control instanceof HTMLInputElement) || control.type !== "checkbox") return;
  const ref = control.dataset.ref;
  if (ref !== undefined) void toggleTodo(ref, control.checked);
});

app.ontoolresult = (result) => {
  receivedInitialResult = true;
  if (result.isError) {
    errorMessage = failureMessage("Could not load todos", result);
  } else if (!isTodoListResult(result.structuredContent)) {
    errorMessage = "Could not load todos because the tool result was malformed.";
  } else {
    replaceList(result.structuredContent);
    errorMessage = "";
  }
  render();
};

render();

try {
  await app.connect();
} catch (error: unknown) {
  errorMessage = `Could not connect the todo app: ${error instanceof Error ? error.message : "transport error."}`;
  render();
}
