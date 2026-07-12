import { applyAppFilters, type AppFilters } from "../../todos/model.js";
import type {
  TodoListResult,
  TodoMutationResult,
  TodoPriority,
  TodoRecord,
  TodoWarning,
} from "../../../src/todos/types.js";
import type { WebContainerSummary } from "../../../src/web/types.js";
import { getContainers, getTodos, mutateTodo } from "../api.js";
import { errorMessage, escapeHtml } from "../dom.js";
import type { WebFeature } from "../feature.js";

interface MemoryModule {
  container: string;
  module: string;
  label: string;
}

interface TodoDraft {
  source: string;
  text: string;
  labels: string;
  due: string;
  priority: TodoPriority;
}

const priorities: TodoPriority[] = ["lowest", "low", "normal", "medium", "high", "highest"];

function todayString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sourceName(task: TodoRecord): string {
  return `${task.source.container}/${task.source.module}`;
}

function memoryModules(containers: WebContainerSummary[]): MemoryModule[] {
  return containers.flatMap((container) => container.modules
    .filter((module) => module.type === "memory")
    .map((module) => ({
      container: container.name,
      module: module.path,
      label: `${container.name}/${module.path}`,
    })));
}

function parseLabels(value: string): string[] {
  return [...new Set(value
    .split(/[,\s]+/u)
    .map((label) => label.trim().replace(/^#/u, "").toLowerCase())
    .filter(Boolean))];
}

function isApplied(result: TodoMutationResult): result is Extract<TodoMutationResult, { applied: true }> {
  return result.applied;
}

export const todosFeature: WebFeature = {
  id: "todos",
  label: "Todos",
  path: "/todos",
  title: "Todos",
  async mount({ root, signal, setStatus }) {
    let tasks: TodoRecord[] = [];
    let warnings: TodoWarning[] = [];
    let modules: MemoryModule[] = [];
    let error = "";
    let notice = "";
    let loaded = false;
    let creating = false;
    const pendingRefs = new Set<string>();
    const dirtyContainers = new Set<string>();
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
    const draft: TodoDraft = {
      source: "",
      text: "",
      labels: "",
      due: "",
      priority: "normal",
    };

    function availableLabels(): string[] {
      return [...new Set(tasks.flatMap((task) => task.labels))].sort((left, right) => left.localeCompare(right));
    }

    function availableSources(): string[] {
      return [...new Set(tasks.map(sourceName))].sort((left, right) => left.localeCompare(right));
    }

    function renderBanners(): string {
      const dirty = [...dirtyContainers].sort((left, right) => left.localeCompare(right));
      return [
        error ? `<div class="banner banner-error" role="alert">${escapeHtml(error)}</div>` : "",
        notice ? `<div class="banner banner-success" role="status">${escapeHtml(notice)}</div>` : "",
        dirty.length > 0
          ? `<div class="banner banner-warning" role="status">Local todo changes are not synced: ${dirty.map(escapeHtml).join(", ")}.</div>`
          : "",
        warnings.length > 0
          ? `<div class="banner banner-warning"><strong>${warnings.length} scan warning${warnings.length === 1 ? "" : "s"}</strong></div>`
          : "",
      ].join("");
    }

    function renderCreatePanel(): string {
      const disabled = creating ? " disabled" : "";
      const options = modules.map((module) => `
        <option value="${escapeHtml(module.label)}"${draft.source === module.label ? " selected" : ""}>${escapeHtml(module.label)}</option>
      `).join("");
      return `
        <section class="panel">
          <div class="panel-header"><h2>Add todo</h2></div>
          <form id="create-todo-form" class="panel-body form-grid">
            <label class="field">Memory module
              <select name="source" required${modules.length === 0 || creating ? " disabled" : ""}>
                <option value="">Select a module</option>
                ${options}
              </select>
            </label>
            <label class="field">Todo
              <textarea name="text" required placeholder="What needs to be done?"${disabled}>${escapeHtml(draft.text)}</textarea>
            </label>
            <label class="field">Labels
              <input name="labels" value="${escapeHtml(draft.labels)}" placeholder="work, release"${disabled}>
            </label>
            <label class="field">Due date
              <input name="due" type="date" value="${escapeHtml(draft.due)}"${disabled}>
            </label>
            <label class="field">Priority
              <select name="priority"${disabled}>
                ${priorities.map((priority) => `<option value="${priority}"${draft.priority === priority ? " selected" : ""}>${priority}</option>`).join("")}
              </select>
            </label>
            <button class="primary-button" type="submit"${modules.length === 0 || creating ? " disabled" : ""}>${creating ? "Adding..." : "Add todo"}</button>
            ${modules.length === 0 ? '<span class="muted">Add a memory module before creating todos.</span>' : ""}
          </form>
        </section>
      `;
    }

    function renderFilters(): string {
      const statuses = (["all", "open", "completed", "custom"] as const).map((status) => {
        const count = status === "all" ? tasks.length : tasks.filter((task) => task.status === status).length;
        return `<button class="segmented-button" type="button" data-status="${status}" aria-pressed="${filters.status === status}">${status} ${count}</button>`;
      }).join("");
      const sources = availableSources().map((source) => `
        <option value="${escapeHtml(source)}"${filters.source === source ? " selected" : ""}>${escapeHtml(source)}</option>
      `).join("");
      const labels = availableLabels();
      return `
        <section class="panel">
          <div class="panel-header"><h2>Filters</h2></div>
          <div class="panel-body filter-grid">
            <div class="status-buttons" role="group" aria-label="Todo status">${statuses}</div>
            <label class="field">Source
              <select id="todo-source-filter">
                <option value="">All sources</option>
                ${sources}
              </select>
            </label>
            <label class="field">Search
              <input id="todo-query-filter" type="search" value="${escapeHtml(filters.query)}" placeholder="Text or label">
            </label>
            <div>
              <span class="field">Labels</span>
              <div class="label-chips">
                ${labels.length === 0
                  ? '<span class="muted">No labels</span>'
                  : labels.map((label) => `<button class="chip" type="button" data-label="${escapeHtml(label)}" aria-pressed="${filters.labels.includes(label)}">#${escapeHtml(label)}</button>`).join("")}
              </div>
            </div>
            <button class="secondary-button" type="button" data-action="clear-filters">Clear filters</button>
          </div>
        </section>
      `;
    }

    function renderTask(task: TodoRecord): string {
      const pending = pendingRefs.has(task.ref);
      const readOnly = task.readOnly || task.status === "custom";
      const taskWarnings = [
        ...task.warnings,
        ...(readOnly ? ["This checkbox status is read-only."] : []),
      ];
      return `
        <li class="todo-row${task.status === "completed" ? " completed" : ""}${pending ? " pending" : ""}">
          <input
            class="todo-check"
            type="checkbox"
            data-ref="${escapeHtml(task.ref)}"
            aria-label="${task.status === "completed" ? "Reopen" : "Complete"} ${escapeHtml(task.text)}"
            ${task.status === "completed" ? "checked" : ""}
            ${readOnly || pending ? "disabled" : ""}
          >
          <div class="todo-main">
            <div class="todo-title">${escapeHtml(task.text)}</div>
            <div class="todo-meta">
              <span>${escapeHtml(sourceName(task))} / ${escapeHtml(task.source.path)}:${task.source.line}</span>
              <span class="badge priority-${task.priority}">${escapeHtml(task.priority)}</span>
              <span>${task.due ? `Due ${escapeHtml(task.due)}` : "No due date"}</span>
              ${task.labels.map((label) => `<span class="badge">#${escapeHtml(label)}</span>`).join("")}
              ${pending ? "<span>Updating...</span>" : ""}
            </div>
            ${taskWarnings.map((message) => `<div class="task-warning">${escapeHtml(message)}</div>`).join("")}
          </div>
        </li>
      `;
    }

    function render(): void {
      const filtered = applyAppFilters(tasks, filters, todayString());
      root.innerHTML = `
        <section class="feature">
          <header class="feature-heading">
            <div>
              <h1>Todos</h1>
              <p>${loaded ? `${filtered.length} of ${tasks.length} tasks shown` : "Loading todo list..."}</p>
            </div>
            <button class="secondary-button" type="button" data-action="refresh-todos">Refresh</button>
          </header>
          ${renderBanners()}
          <div class="todos-layout">
            <aside class="todo-sidebar">
              ${renderCreatePanel()}
              ${renderFilters()}
            </aside>
            <section class="todo-content" aria-label="Todo list">
              ${!loaded
                ? '<div class="panel loading-state">Loading todos...</div>'
                : filtered.length === 0
                  ? '<div class="panel empty-state">No todos match the current filters.</div>'
                  : `<ul class="todo-list">${filtered.map(renderTask).join("")}</ul>`}
            </section>
          </div>
        </section>
      `;
      setStatus(loaded ? `${tasks.length} todo${tasks.length === 1 ? "" : "s"}` : "Loading todos");
    }

    function replaceTodos(result: TodoListResult): void {
      tasks = [...result.tasks];
      warnings = [...result.warnings];
      loaded = true;
      if (filters.source && !availableSources().includes(filters.source)) filters.source = "";
      filters.labels = filters.labels.filter((label) => availableLabels().includes(label));
    }

    async function refresh(): Promise<void> {
      error = "";
      notice = "";
      render();
      try {
        const result = await getTodos(signal);
        replaceTodos(result);
      } catch (caught: unknown) {
        if (signal.aborted) return;
        error = errorMessage(caught);
        loaded = true;
      }
      render();
    }

    async function loadSources(): Promise<void> {
      try {
        const result = await getContainers(signal);
        modules = memoryModules(result.containers);
        if (!draft.source && modules[0]) draft.source = modules[0].label;
      } catch (caught: unknown) {
        if (!signal.aborted) error = errorMessage(caught);
      }
    }

    async function createTodo(form: HTMLFormElement): Promise<void> {
      if (creating) return;
      const data = new FormData(form);
      draft.source = String(data.get("source") ?? "");
      draft.text = String(data.get("text") ?? "");
      draft.labels = String(data.get("labels") ?? "");
      draft.due = String(data.get("due") ?? "");
      const priority = String(data.get("priority") ?? "normal");
      draft.priority = priorities.includes(priority as TodoPriority) ? priority as TodoPriority : "normal";
      const source = modules.find((module) => module.label === draft.source);
      if (!source) {
        error = "Select a memory module.";
        notice = "";
        render();
        return;
      }

      error = "";
      notice = "";
      creating = true;
      setStatus("Creating todo");
      render();
      try {
        const result = await mutateTodo({
          operation: "create",
          container: source.container,
          module: source.module,
          text: draft.text,
          labels: parseLabels(draft.labels),
          ...(draft.due ? { due: draft.due } : {}),
          priority: draft.priority,
          apply: true,
        }, signal);
        if (!isApplied(result)) throw new Error("The server returned a todo preview instead of applying it.");
        dirtyContainers.add(result.dirtyContainer);
        draft.text = "";
        draft.labels = "";
        draft.due = "";
        notice = `Added "${result.todo.text}".`;
        replaceTodos(await getTodos(signal));
      } catch (caught: unknown) {
        if (!signal.aborted) error = errorMessage(caught);
      } finally {
        creating = false;
      }
      if (!signal.aborted) render();
    }

    async function toggleTodo(ref: string, completed: boolean): Promise<void> {
      if (pendingRefs.has(ref)) return;
      pendingRefs.add(ref);
      error = "";
      notice = "";
      render();
      try {
        const result = await mutateTodo({ operation: "update", ref, completed, apply: true }, signal);
        if (!isApplied(result)) throw new Error("The server returned a todo preview instead of applying it.");
        const index = tasks.findIndex((task) => task.ref === ref);
        if (index >= 0) tasks[index] = result.todo;
        dirtyContainers.add(result.dirtyContainer);
      } catch (caught: unknown) {
        if (signal.aborted) return;
        error = errorMessage(caught);
        try {
          replaceTodos(await getTodos(signal));
        } catch (refreshError: unknown) {
          if (!signal.aborted) error = `${error} Refresh failed: ${errorMessage(refreshError)}`;
        }
      } finally {
        pendingRefs.delete(ref);
      }
      render();
    }

    root.addEventListener("submit", (event) => {
      if (!(event.target instanceof HTMLFormElement) || event.target.id !== "create-todo-form") return;
      event.preventDefault();
      void createTodo(event.target);
    }, { signal });

    root.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const control = event.target.closest<HTMLElement>("[data-action], [data-status], [data-label]");
      if (!control) return;
      if (control.dataset.action === "refresh-todos") {
        void refresh();
        return;
      }
      if (control.dataset.action === "clear-filters") {
        filters.status = "all";
        filters.labels = [];
        filters.source = "";
        filters.query = "";
        render();
        return;
      }
      const status = control.dataset.status;
      if (status === "all" || status === "open" || status === "completed" || status === "custom") {
        filters.status = status;
        render();
        return;
      }
      const label = control.dataset.label;
      if (label !== undefined) {
        filters.labels = filters.labels.includes(label)
          ? filters.labels.filter((candidate) => candidate !== label)
          : [...filters.labels, label];
        render();
      }
    }, { signal });

    root.addEventListener("change", (event) => {
      const control = event.target;
      if (
        (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)
        && control.form?.id === "create-todo-form"
      ) {
        if (control.name === "source") draft.source = control.value;
        if (control.name === "text") draft.text = control.value;
        if (control.name === "labels") draft.labels = control.value;
        if (control.name === "due") draft.due = control.value;
        if (control.name === "priority" && priorities.includes(control.value as TodoPriority)) {
          draft.priority = control.value as TodoPriority;
        }
      }
      if (control instanceof HTMLInputElement && control.classList.contains("todo-check")) {
        const ref = control.dataset.ref;
        if (ref) void toggleTodo(ref, control.checked);
        return;
      }
      if (control instanceof HTMLSelectElement && control.id === "todo-source-filter") {
        filters.source = control.value;
        render();
        return;
      }
      if (control instanceof HTMLInputElement && control.id === "todo-query-filter") {
        filters.query = control.value;
        render();
      }
    }, { signal });

    root.addEventListener("input", (event) => {
      const control = event.target;
      if (
        (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)
        && control.form?.id === "create-todo-form"
      ) {
        if (control.name === "text") draft.text = control.value;
        if (control.name === "labels") draft.labels = control.value;
      }
    }, { signal });

    render();
    await Promise.all([loadSources(), refresh()]);
    render();
  },
};
