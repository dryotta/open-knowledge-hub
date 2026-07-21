import type {
  ProjectSummary,
  ResultFile,
  ResultRecord,
  WorkspaceGetResult,
} from "../../../src/workspaces/types.js";
import type {
  WebAttentionEntry,
  WebWorkspaceDetailResponse,
  WebWorkspaceSummary,
} from "../../../src/web/types.js";
import {
  getAttention,
  getProject,
  getWorkspace,
  getWorkspaces,
  mutateWorkspace,
} from "../api.js";
import { errorMessage, escapeHtml, formatBytes } from "../dom.js";
import type { FeatureContext, WebFeature } from "../feature.js";
import {
  projectPath,
  workspacePath,
} from "../routing.js";

function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/\r?\n|,/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function displayDate(value?: string): string {
  if (!value) return "Not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function projectCard(container: string, module: string, project: ProjectSummary): string {
  return `
    <a class="workspace-card project-card" data-route
      href="${projectPath(container, module, project.id)}">
      <div class="card-heading">
        <strong>${escapeHtml(project.title)}</strong>
        <span class="badge">${escapeHtml(project.status)}</span>
      </div>
      <p>${project.attention
        ? escapeHtml(project.attention.summary)
        : project.activeRun
          ? "Run in progress"
          : project.currentResult
            ? "Result available"
            : "Ready for an MCP client"}</p>
      <div class="card-meta">
        <span>Updated ${escapeHtml(displayDate(project.updatedAt))}</span>
        ${project.targetDate ? `<span>Target ${escapeHtml(project.targetDate)}</span>` : ""}
        ${project.tags.map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}
      </div>
    </a>
  `;
}

function workspaceCard(workspace: WebWorkspaceSummary): string {
  return `
    <a class="workspace-card" data-route href="${workspacePath(workspace.container, workspace.module)}">
      <div class="card-heading">
        <strong>${escapeHtml(workspace.module)}</strong>
        <span class="badge">${escapeHtml(workspace.sync?.mode ?? "local")}</span>
      </div>
      <p>${escapeHtml(workspace.description || "No description")}</p>
      ${workspace.issue
        ? `<div class="task-warning">${escapeHtml(workspace.issue)}</div>`
        : `<div class="metric-row">
            <span><strong>${workspace.counts?.active ?? 0}</strong> active</span>
            <span><strong>${workspace.counts?.activeRuns ?? 0}</strong> running</span>
            <span><strong>${workspace.counts?.attention ?? 0}</strong> attention</span>
          </div>`}
      <div class="card-meta">
        <span>${escapeHtml(workspace.container)}</span>
        ${workspace.nearestTargetDate
          ? `<span>Nearest target ${escapeHtml(workspace.nearestTargetDate)}</span>`
          : ""}
        ${workspace.agentHealth
          ? `<span class="${workspace.agentHealth === "valid" ? "success-text" : "task-warning"}">
              Agents ${escapeHtml(workspace.agentHealth)}
            </span>`
          : ""}
      </div>
    </a>
  `;
}

async function renderWorkspaceCollection(context: FeatureContext): Promise<void> {
  const { root, signal, setStatus } = context;
  const response = await getWorkspaces(signal);
  root.innerHTML = `
    <section class="feature">
      <header class="feature-heading">
        <div>
          <h1>Workspaces</h1>
          <p>Durable projects coordinated by your MCP client and configured agents.</p>
        </div>
        <a class="secondary-button button-link" data-route href="/workspaces/attention">
          Needs attention
        </a>
      </header>
      <div class="workspace-grid">
        ${response.workspaces.length
          ? response.workspaces.map(workspaceCard).join("")
          : '<div class="panel empty-state">No workspace modules are registered.</div>'}
      </div>
      <div class="banner banner-warning">
        Runs start and continue in an MCP client. This web UI manages durable project state,
        review, guidance, results, and settings.
      </div>
    </section>
  `;
  setStatus(`${response.workspaces.length} workspace${response.workspaces.length === 1 ? "" : "s"}`);
}

async function renderAttention(context: FeatureContext): Promise<void> {
  const { root, signal, setStatus } = context;
  let response = await getAttention(signal);
  let failure = "";
  let notice = "";

  function render(): void {
    root.innerHTML = `
      <section class="feature">
        <header class="feature-heading">
          <div>
            <h1>Needs attention</h1>
            <p>Paused projects waiting for human guidance or cancellation.</p>
          </div>
          <a class="secondary-button button-link" data-route href="/workspaces">All workspaces</a>
        </header>
        ${failure ? `<div class="banner banner-error" role="alert">${escapeHtml(failure)}</div>` : ""}
        ${notice ? `<div class="banner banner-success">${escapeHtml(notice)}</div>` : ""}
        <div class="workspace-grid">
          ${response.entries.length
            ? response.entries.map((entry: WebAttentionEntry, index) => `
                <article class="workspace-card attention-card">
                  <div class="card-heading">
                    <a data-route href="${projectPath(entry.container, entry.module, entry.project.id)}">
                      <strong>${escapeHtml(entry.project.title)}</strong>
                    </a>
                    <span class="badge">paused</span>
                  </div>
                  <p>${escapeHtml(entry.project.attention?.summary ?? "Human input requested")}</p>
                  ${entry.project.attention?.question
                    ? `<blockquote>${escapeHtml(entry.project.attention.question)}</blockquote>`
                    : ""}
                  <div class="card-meta">
                    <span>${escapeHtml(entry.container)}/${escapeHtml(entry.module)}</span>
                    <span>${escapeHtml(displayDate(entry.project.updatedAt))}</span>
                  </div>
                  ${entry.detail.validActions.includes("guide")
                    ? `<form class="form-grid attention-actions" data-attention="${index}" data-action="guide">
                        <label class="field">Guidance
                          <textarea required name="guidance"></textarea>
                        </label>
                        <button class="primary-button" type="submit">Send guidance</button>
                      </form>`
                    : ""}
                  <form class="inline-form attention-actions" data-attention="${index}" data-action="cancel">
                    <label class="field">Cancellation reason
                      <input required name="reason">
                    </label>
                    <button class="secondary-button danger-button" type="submit">Cancel run</button>
                  </form>
                </article>
              `).join("")
            : '<div class="panel empty-state">No projects currently need human attention.</div>'}
        </div>
      </section>
    `;
    setStatus(`${response.entries.length} attention item${response.entries.length === 1 ? "" : "s"}`);
  }

  root.addEventListener("submit", async (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    const index = Number(event.target.dataset.attention);
    const entry = response.entries[index];
    const action = event.target.dataset.action;
    if (!entry?.detail.resume || (action !== "guide" && action !== "cancel")) return;
    event.preventDefault();
    const data = new FormData(event.target);
    failure = "";
    notice = "";
    try {
      await mutateWorkspace(entry.container, entry.module, {
        operation: "intervene",
        run: entry.detail.resume.runId,
        action,
        ...(action === "guide"
          ? { guidance: String(data.get("guidance") ?? "").trim() }
          : { reason: String(data.get("reason") ?? "").trim() }),
        etag: entry.detail.etag,
        commandId: crypto.randomUUID(),
      }, entry.project.id, signal);
      notice = action === "guide" ? "Guidance recorded." : "Run cancelled.";
      response = await getAttention(signal);
      render();
    } catch (error) {
      failure = errorMessage(error);
      render();
    }
  }, { signal });

  render();
}

async function renderWorkspaceDetail(
  context: FeatureContext,
  container: string,
  module: string,
): Promise<void> {
  const { root, signal, setStatus } = context;
  let response: WebWorkspaceDetailResponse;
  let notice = "";
  let failure = "";
  const filterKey = `okh.workspace.filters.${container}/${module}`;
  let filters = {
    status: "all",
    query: "",
    tags: "",
    targetAfter: "",
    targetBefore: "",
    sort: "updatedAt",
    order: "desc",
  };
  try {
    const saved = localStorage.getItem(filterKey);
    if (saved) {
      const parsed = JSON.parse(saved) as Record<string, unknown>;
      filters = {
        status: parsed.status === "active" || parsed.status === "archived" ? parsed.status : "all",
        query: typeof parsed.query === "string" ? parsed.query : "",
        tags: typeof parsed.tags === "string" ? parsed.tags : "",
        targetAfter: typeof parsed.targetAfter === "string" ? parsed.targetAfter : "",
        targetBefore: typeof parsed.targetBefore === "string" ? parsed.targetBefore : "",
        sort: ["updatedAt", "createdAt", "targetDate", "title"].includes(String(parsed.sort))
          ? String(parsed.sort)
          : "updatedAt",
        order: parsed.order === "asc" ? "asc" : "desc",
      };
    }
  } catch {
    failure = "Saved project filters were invalid and have been reset.";
    localStorage.removeItem(filterKey);
  }

  function visibleProjects(): ProjectSummary[] {
    const query = filters.query.trim().toLocaleLowerCase();
    const tags = lines(filters.tags);
    const projects = response.projects.filter((project) => {
      if (filters.status !== "all" && project.status !== filters.status) return false;
      if (
        query
        && ![project.id, project.title, ...project.tags]
          .some((value) => value.toLocaleLowerCase().includes(query))
      ) return false;
      if (tags.length && !tags.every((tag) => project.tags.includes(tag.toLocaleLowerCase()))) {
        return false;
      }
      if (filters.targetAfter && (!project.targetDate || project.targetDate < filters.targetAfter)) {
        return false;
      }
      if (filters.targetBefore && (!project.targetDate || project.targetDate > filters.targetBefore)) {
        return false;
      }
      return true;
    });
    projects.sort((left, right) => {
      const leftValue = filters.sort === "title"
        ? left.title.toLocaleLowerCase()
        : filters.sort === "createdAt"
          ? left.createdAt
          : filters.sort === "targetDate"
            ? left.targetDate
            : left.updatedAt;
      const rightValue = filters.sort === "title"
        ? right.title.toLocaleLowerCase()
        : filters.sort === "createdAt"
          ? right.createdAt
          : filters.sort === "targetDate"
            ? right.targetDate
            : right.updatedAt;
      if (leftValue === undefined) return rightValue === undefined ? 0 : 1;
      if (rightValue === undefined) return -1;
      const compared = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      return filters.order === "asc" ? compared : -compared;
    });
    return projects;
  }

  async function load(): Promise<void> {
    response = await getWorkspace(container, module, signal);
    render();
  }

  function render(): void {
    const workspace = response.detail.workspace;
    if (!workspace) throw new Error("Workspace detail is unavailable.");
    const projects = visibleProjects();
    root.innerHTML = `
      <section class="feature">
        <nav class="breadcrumbs">
          <a data-route href="/workspaces">Workspaces</a>
          <span class="muted">/</span>
          <span>${escapeHtml(container)}</span>
          <span class="muted">/</span>
          <strong>${escapeHtml(module)}</strong>
        </nav>
        <header class="feature-heading">
          <div>
            <h1>${escapeHtml(module)}</h1>
            <p>${escapeHtml(workspace.description || "No description")}</p>
          </div>
          <span class="badge">${escapeHtml(response.sync?.mode ?? "local")}</span>
        </header>
        ${failure ? `<div class="banner banner-error" role="alert">${escapeHtml(failure)}</div>` : ""}
        ${notice ? `<div class="banner banner-success">${escapeHtml(notice)}</div>` : ""}
        ${workspace.agentIssues.length
          ? `<div class="banner banner-warning">${workspace.agentIssues.map(escapeHtml).join("<br>")}</div>`
          : ""}
        <div class="metric-row metric-panels">
          <span><strong>${response.detail.counts?.active ?? 0}</strong> active</span>
          <span><strong>${response.detail.counts?.archived ?? 0}</strong> archived</span>
          <span><strong>${response.detail.counts?.activeRuns ?? 0}</strong> running</span>
          <span><strong>${response.detail.counts?.attention ?? 0}</strong> attention</span>
        </div>
        <div class="workspace-detail-grid">
          <section class="panel">
            <div class="panel-header">
              <h2>Projects</h2>
              <span class="file-meta">${projects.length} of ${response.projects.length}</span>
            </div>
            <form class="panel-body project-filters" data-form="project-filters">
              <label class="field">Search
                <input name="query" value="${escapeHtml(filters.query)}">
              </label>
              <label class="field">Status
                <select name="status">
                  ${["all", "active", "archived"].map((value) =>
                    `<option value="${value}" ${filters.status === value ? "selected" : ""}>${value}</option>`)
                    .join("")}
                </select>
              </label>
              <label class="field">Tags, all required
                <input name="tags" value="${escapeHtml(filters.tags)}">
              </label>
              <label class="field">Target after
                <input type="date" name="targetAfter" value="${escapeHtml(filters.targetAfter)}">
              </label>
              <label class="field">Target before
                <input type="date" name="targetBefore" value="${escapeHtml(filters.targetBefore)}">
              </label>
              <label class="field">Sort
                <select name="sort">
                  ${["updatedAt", "createdAt", "targetDate", "title"].map((value) =>
                    `<option value="${value}" ${filters.sort === value ? "selected" : ""}>${value}</option>`)
                    .join("")}
                </select>
              </label>
              <label class="field">Order
                <select name="order">
                  <option value="desc" ${filters.order === "desc" ? "selected" : ""}>descending</option>
                  <option value="asc" ${filters.order === "asc" ? "selected" : ""}>ascending</option>
                </select>
              </label>
              <div class="filter-actions">
                <button class="primary-button" type="submit">Apply</button>
                <button class="secondary-button" type="button" data-action="reset-project-filters">
                  Reset
                </button>
              </div>
            </form>
            <div class="panel-body project-list">
              ${projects.length
                ? projects.map((project) => projectCard(container, module, project)).join("")
                : '<div class="empty-state">No projects match these filters.</div>'}
            </div>
          </section>
          <aside class="workspace-sidebar">
            <section class="panel">
              <div class="panel-header"><h2>New project</h2></div>
              <form class="panel-body form-grid" data-form="create-project">
                <label class="field">Project ID
                  <input required name="project" pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                    placeholder="supplier-risk">
                </label>
                <label class="field">Title<input required name="title"></label>
                <label class="field">Goal<textarea required name="goal"></textarea></label>
                <label class="field">Acceptance, one per line<textarea name="acceptance"></textarea></label>
                <label class="field">Target date<input type="date" name="targetDate"></label>
                <label class="field">Tags, comma separated<input name="tags"></label>
                <button class="primary-button" type="submit">Create project</button>
              </form>
            </section>
            <details class="panel settings-panel">
              <summary class="panel-header"><strong>Workspace settings</strong></summary>
              <form class="panel-body form-grid" data-form="workspace-settings">
                <label class="field">Description
                  <textarea name="description">${escapeHtml(workspace.description)}</textarea>
                </label>
                <label class="field">Lead agent
                  <input required name="lead" value="${escapeHtml(workspace.lead)}">
                </label>
                <label class="field">Agent pool, one per line
                  <textarea name="agents">${escapeHtml(workspace.agents.join("\n"))}</textarea>
                </label>
                <button class="secondary-button" type="submit">Save agent settings</button>
              </form>
              <form class="panel-body form-grid bordered-form" data-form="workspace-content">
                <label class="field">Guidance
                  <textarea name="guidance">${escapeHtml(workspace.guidance)}</textarea>
                </label>
                <label class="field">Acceptance, one per line
                  <textarea name="acceptance">${escapeHtml(workspace.acceptance.join("\n"))}</textarea>
                </label>
                <button class="secondary-button" type="submit">Save workspace instructions</button>
              </form>
            </details>
          </aside>
        </div>
      </section>
    `;
    setStatus(`${response.projects.length} project${response.projects.length === 1 ? "" : "s"}`);
  }

  root.addEventListener("submit", async (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    failure = "";
    notice = "";
    const data = new FormData(event.target);
    const form = event.target.dataset.form;
    if (form === "project-filters") {
      filters = {
        status: String(data.get("status") ?? "all"),
        query: String(data.get("query") ?? ""),
        tags: String(data.get("tags") ?? ""),
        targetAfter: String(data.get("targetAfter") ?? ""),
        targetBefore: String(data.get("targetBefore") ?? ""),
        sort: String(data.get("sort") ?? "updatedAt"),
        order: String(data.get("order") ?? "desc"),
      };
      try {
        localStorage.setItem(filterKey, JSON.stringify(filters));
      } catch {
        failure = "Project filters applied, but the browser could not remember them.";
      }
      render();
      return;
    }
    try {
      if (form === "create-project") {
        const acceptance = lines(data.get("acceptance"));
        const targetDate = String(data.get("targetDate") ?? "").trim();
        const tags = lines(data.get("tags"));
        await mutateWorkspace(container, module, {
          operation: "create",
          project: String(data.get("project") ?? "").trim(),
          title: String(data.get("title") ?? "").trim(),
          goal: String(data.get("goal") ?? "").trim(),
          ...(acceptance.length ? { acceptance } : {}),
          ...(targetDate ? { targetDate } : {}),
          ...(tags.length ? { tags } : {}),
          commandId: crypto.randomUUID(),
        }, undefined, signal);
        notice = "Project created.";
      } else if (form === "workspace-settings") {
        await mutateWorkspace(container, module, {
          operation: "configure",
          set: {
            description: String(data.get("description") ?? ""),
            lead: String(data.get("lead") ?? "").trim(),
            agents: lines(data.get("agents")),
          },
        }, undefined, signal);
        notice = "Agent settings saved.";
      } else if (form === "workspace-content") {
        await mutateWorkspace(container, module, {
          operation: "update",
          patch: {
            guidance: String(data.get("guidance") ?? ""),
            acceptance: lines(data.get("acceptance")),
          },
          etag: response.detail.etag,
          commandId: crypto.randomUUID(),
        }, undefined, signal);
        notice = "Workspace instructions saved.";
      }
      await load();
    } catch (error) {
      failure = errorMessage(error);
      render();
    }
  }, { signal });

  root.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest("[data-action='reset-project-filters']")) return;
    filters = {
      status: "all",
      query: "",
      tags: "",
      targetAfter: "",
      targetBefore: "",
      sort: "updatedAt",
      order: "desc",
    };
    try {
      localStorage.removeItem(filterKey);
    } catch {
      failure = "Project filters reset, but saved browser settings could not be removed.";
    }
    render();
  }, { signal });

  await load();
}

export function resultDiff(previous: ResultRecord, current: ResultRecord): string {
  const before = new Map(previous.files.map((file) => [file.path, file.sha256]));
  const after = new Map(current.files.map((file) => [file.path, file.sha256]));
  const added = [...after.keys()].filter((path) => !before.has(path));
  const removed = [...before.keys()].filter((path) => !after.has(path));
  const changed = [...after.keys()].filter((path) =>
    before.has(path) && before.get(path) !== after.get(path));
  if (!added.length && !removed.length && !changed.length) return "No file changes.";
  return [
    ...added.map((path) => `Added: ${path}`),
    ...changed.map((path) => `Changed: ${path}`),
    ...removed.map((path) => `Removed: ${path}`),
  ].map(escapeHtml).join("<br>");
}

function resultFiles(
  container: string,
  module: string,
  result: ResultRecord,
  files: ResultFile[],
): string {
  if (!files.length) return '<div class="muted">No files.</div>';
  return `<ul class="result-files">${files.map((file) => {
    const query = new URLSearchParams({
      container,
      module,
      path: `${result.path}/${file.path}`,
    });
    return `<li>
      <a target="_blank" rel="noreferrer" href="/api/file?${query.toString()}">
        ${escapeHtml(file.path)}
      </a>
      <span class="file-meta">${formatBytes(file.size)}</span>
    </li>`;
  }).join("")}</ul>`;
}

async function renderProject(
  context: FeatureContext,
  container: string,
  module: string,
  projectId: string,
): Promise<void> {
  const { root, signal, setStatus } = context;
  let response = await getProject(container, module, projectId, signal);
  let failure = "";
  let notice = "";
  const allowedTabs = new Set(["overview", "activity", "result", "settings"]);
  const requestedTab = new URLSearchParams(window.location.search).get("tab") ?? "overview";
  const tab = allowedTabs.has(requestedTab) ? requestedTab : "overview";

  async function refresh(message = ""): Promise<void> {
    notice = message;
    response = await getProject(container, module, projectId, signal);
    render();
  }

  function renderIntervention(detail: WorkspaceGetResult): string {
    const project = detail.project;
    const resume = detail.resume;
    if (!project?.activeRun || !resume) return "";
    const canGuide = detail.validActions.includes("guide");
    return `
      <section class="panel intervention-panel">
        <div class="panel-header">
          <h2>${canGuide ? "Human input requested" : "Active run"}</h2>
          <span class="badge">${escapeHtml(resume.runId)}</span>
        </div>
        <div class="panel-body form-grid">
          ${resume.checkpoint
            ? `<p>${escapeHtml(resume.checkpoint.summary)}</p>
               ${resume.checkpoint.question
                 ? `<blockquote>${escapeHtml(resume.checkpoint.question)}</blockquote>`
                 : ""}`
            : '<p class="muted">The MCP client has not reported a checkpoint.</p>'}
          ${canGuide
            ? `<form class="form-grid" data-form="guide">
                <label class="field">Guidance<textarea required name="guidance"></textarea></label>
                <button class="primary-button" type="submit">Send guidance</button>
              </form>`
            : ""}
          <form class="inline-form" data-form="cancel">
            <label class="field">Cancellation reason<input required name="reason"></label>
            <button class="secondary-button danger-button" type="submit">Cancel run</button>
          </form>
        </div>
      </section>
    `;
  }

  function renderTab(detail: WorkspaceGetResult): string {
    const project = detail.project;
    if (!project) throw new Error("Project detail is unavailable.");
    if (tab === "activity") {
      return `<section class="panel">
        <div class="panel-header"><h2>Activity</h2></div>
        <div class="panel-body activity-list">
          ${response.activity.length
            ? response.activity.map((entry) => `
                <article class="activity-entry">
                  <div class="activity-marker"></div>
                  <div>
                    <div class="card-heading">
                      <strong>${escapeHtml(entry.summary)}</strong>
                      <time>${escapeHtml(displayDate(entry.time))}</time>
                    </div>
                    <div class="card-meta">
                      <span>${escapeHtml(entry.type)}</span>
                      ${entry.runId ? `<span>Run ${escapeHtml(entry.runId)}</span>` : ""}
                    </div>
                    ${entry.question ? `<blockquote>${escapeHtml(entry.question)}</blockquote>` : ""}
                    ${entry.guidance ? `<p>${escapeHtml(entry.guidance)}</p>` : ""}
                    ${entry.reason ? `<p class="task-warning">${escapeHtml(entry.reason)}</p>` : ""}
                  </div>
                </article>
              `).join("")
            : '<div class="empty-state">No activity has been recorded.</div>'}
        </div>
      </section>`;
    }
    if (tab === "result") {
      const results = detail.results ?? [];
      return `<section class="panel">
        <div class="panel-header"><h2>Result history</h2></div>
        <div class="panel-body result-list">
          ${results.length
            ? results.map((result, index) => `
                <details class="result-entry" ${result.path === project.result ? "open" : ""}>
                  <summary>
                    <strong>Run ${escapeHtml(result.runId)}</strong>
                    <span>${escapeHtml(displayDate(result.finishedAt))}</span>
                    ${result.path === project.result ? '<span class="badge">current</span>' : ""}
                  </summary>
                  <div class="result-body">
                    <div class="card-meta">
                      <span>${result.files.length} files</span>
                      <span>Tree ${escapeHtml(result.treeHash.slice(0, 12))}</span>
                    </div>
                    ${index < results.length - 1
                      ? `<details><summary>Changes from previous result</summary>
                           <div class="diff-summary">${resultDiff(results[index + 1]!, result)}</div>
                         </details>`
                      : ""}
                    <section class="result-evidence">
                      <h3>Criterion evidence</h3>
                      ${result.evidence.length
                        ? `<dl class="definition-grid">${result.evidence.map((entry) => `
                            <dt>${escapeHtml(entry.criterion)}</dt>
                            <dd>${entry.references.map((reference) =>
                              `<code>${escapeHtml(reference)}</code>`).join("<br>")}</dd>
                          `).join("")}</dl>`
                        : '<p class="muted">No criterion evidence was recorded.</p>'}
                    </section>
                    ${resultFiles(container, module, result, result.files)}
                    ${result.path !== project.result && detail.validActions.includes("restore")
                      ? `<button class="secondary-button" type="button"
                           data-restore-run="${escapeHtml(result.runId)}">Restore this result</button>`
                      : ""}
                  </div>
                </details>
              `).join("")
            : '<div class="empty-state">No successful results yet.</div>'}
        </div>
      </section>`;
    }
    if (tab === "settings") {
      return `<div class="settings-grid">
        <section class="panel">
          <div class="panel-header"><h2>Project settings</h2></div>
          <form class="panel-body form-grid" data-form="project-settings">
            <fieldset class="form-grid form-fieldset" ${project.status === "archived" ? "disabled" : ""}>
              <label class="field">Title<input required name="title" value="${escapeHtml(project.title)}"></label>
              <label class="field">Goal<textarea required name="goal">${escapeHtml(project.goal)}</textarea></label>
              <label class="field">Project guidance
                <textarea name="guidance">${escapeHtml(project.guidance ?? "")}</textarea>
              </label>
              <label class="field">Acceptance, one per line
                <textarea name="acceptance">${escapeHtml(project.acceptance.join("\n"))}</textarea>
              </label>
              <label class="field">Target date
                <input type="date" name="targetDate" value="${escapeHtml(project.targetDate ?? "")}">
              </label>
              <label class="field">Tags, comma separated
                <input name="tags" value="${escapeHtml(project.tags.join(", "))}">
              </label>
              <button class="primary-button" type="submit">Save project</button>
            </fieldset>
            ${project.status === "archived"
              ? '<p class="muted">Unarchive this project before changing its settings.</p>'
              : ""}
          </form>
        </section>
        <section class="panel danger-panel">
          <div class="panel-header"><h2>Lifecycle</h2></div>
          <div class="panel-body form-grid">
            <p>${project.status === "archived"
              ? "Unarchive this project to make it operational again."
              : "Archived projects remain readable but cannot be changed or run."}</p>
            ${project.activeRun
              ? '<p id="lifecycle-disabled-reason" class="task-warning">Cancel or finish the active run before archiving.</p>'
              : ""}
            <button class="secondary-button" type="button" data-lifecycle="${project.status === "archived" ? "unarchive" : "archive"}"
              ${project.activeRun ? 'disabled aria-describedby="lifecycle-disabled-reason"' : ""}>
              ${project.status === "archived" ? "Unarchive project" : "Archive project"}
            </button>
          </div>
        </section>
      </div>`;
    }
    return `
      ${renderIntervention(detail)}
      <div class="overview-grid">
        <section class="panel">
          <div class="panel-header"><h2>Goal</h2></div>
          <div class="panel-body prose">${escapeHtml(project.goal)}</div>
        </section>
        <section class="panel">
          <div class="panel-header"><h2>Acceptance</h2></div>
          <div class="panel-body">
            ${project.acceptance.length
              ? `<ul>${project.acceptance.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
              : '<span class="muted">No project-specific criteria.</span>'}
          </div>
        </section>
        <section class="panel">
          <div class="panel-header"><h2>Operational state</h2></div>
          <dl class="panel-body definition-grid">
            <dt>Status</dt><dd>${escapeHtml(project.status)}</dd>
            <dt>Active run</dt><dd>${escapeHtml(project.activeRun ?? "None")}</dd>
            <dt>Current result</dt><dd>${escapeHtml(project.result ?? "None")}</dd>
            <dt>Target</dt><dd>${escapeHtml(project.targetDate ?? "Not set")}</dd>
            <dt>Updated</dt><dd>${escapeHtml(displayDate(project.updatedAt))}</dd>
          </dl>
        </section>
        <section class="panel">
          <div class="panel-header"><h2>How to continue</h2></div>
          <div class="panel-body prose">
            <p>Use your MCP client to start or continue execution:</p>
            <code>hub, reopen ${escapeHtml(project.title)}</code>
            <p class="muted">The client retrieves the frozen run package and coordinates agents.</p>
          </div>
        </section>
      </div>
    `;
  }

  function render(): void {
    const detail = response.detail;
    const project = detail.project;
    if (!project) throw new Error("Project detail is unavailable.");
    const base = projectPath(container, module, projectId);
    root.innerHTML = `
      <section class="feature">
        <nav class="breadcrumbs">
          <a data-route href="/workspaces">Workspaces</a><span class="muted">/</span>
          <a data-route href="${workspacePath(container, module)}">${escapeHtml(module)}</a>
          <span class="muted">/</span><strong>${escapeHtml(project.title)}</strong>
        </nav>
        <header class="feature-heading">
          <div>
            <h1>${escapeHtml(project.title)}</h1>
            <div class="card-meta">
              <span class="badge">${escapeHtml(project.status)}</span>
              ${project.tags.map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}
            </div>
          </div>
          ${project.activeRun
            ? '<span class="badge status-live">Run active</span>'
            : project.result
              ? '<span class="badge success-text">Result ready</span>'
              : '<span class="badge">Ready</span>'}
        </header>
        ${failure ? `<div class="banner banner-error" role="alert">${escapeHtml(failure)}</div>` : ""}
        ${notice ? `<div class="banner banner-success">${escapeHtml(notice)}</div>` : ""}
        <nav class="tab-nav" aria-label="Project sections">
          ${["overview", "activity", "result", "settings"].map((name) => `
            <a data-route href="${base}?tab=${name}" aria-current="${tab === name ? "page" : "false"}">
              ${name[0]!.toUpperCase()}${name.slice(1)}
            </a>`).join("")}
        </nav>
        ${renderTab(detail)}
      </section>
    `;
    setStatus(`${project.status}${project.activeRun ? " / active run" : ""}`);
  }

  root.addEventListener("submit", async (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    failure = "";
    const data = new FormData(event.target);
    const project = response.detail.project;
    if (!project) return;
    try {
      if (event.target.dataset.form === "guide" && response.detail.resume) {
        await mutateWorkspace(container, module, {
          operation: "intervene",
          run: response.detail.resume.runId,
          action: "guide",
          guidance: String(data.get("guidance") ?? "").trim(),
          etag: response.detail.etag,
          commandId: crypto.randomUUID(),
        }, projectId, signal);
        await refresh("Guidance recorded. The MCP client will receive it on continuation.");
      } else if (event.target.dataset.form === "cancel" && response.detail.resume) {
        await mutateWorkspace(container, module, {
          operation: "intervene",
          run: response.detail.resume.runId,
          action: "cancel",
          reason: String(data.get("reason") ?? "").trim(),
          etag: response.detail.etag,
          commandId: crypto.randomUUID(),
        }, projectId, signal);
        await refresh("Run cancelled.");
      } else if (event.target.dataset.form === "project-settings") {
        const targetDate = String(data.get("targetDate") ?? "").trim();
        await mutateWorkspace(container, module, {
          operation: "update",
          patch: {
            title: String(data.get("title") ?? "").trim(),
            goal: String(data.get("goal") ?? "").trim(),
            guidance: String(data.get("guidance") ?? ""),
            acceptance: lines(data.get("acceptance")),
            targetDate: targetDate || null,
            tags: lines(data.get("tags")),
          },
          etag: response.detail.etag,
          commandId: crypto.randomUUID(),
        }, projectId, signal);
        await refresh("Project settings saved.");
      }
    } catch (error) {
      failure = errorMessage(error);
      render();
    }
  }, { signal });

  root.addEventListener("click", async (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const restore = event.target.closest<HTMLElement>("[data-restore-run]");
    const lifecycle = event.target.closest<HTMLButtonElement>("[data-lifecycle]");
    try {
      if (restore?.dataset.restoreRun) {
        await mutateWorkspace(container, module, {
          operation: "update",
          action: "restore",
          fromRun: restore.dataset.restoreRun,
          etag: response.detail.etag,
          commandId: crypto.randomUUID(),
        }, projectId, signal);
        await refresh("Result restored.");
      } else if (lifecycle?.dataset.lifecycle === "archive" || lifecycle?.dataset.lifecycle === "unarchive") {
        await mutateWorkspace(container, module, {
          operation: "update",
          action: lifecycle.dataset.lifecycle,
          etag: response.detail.etag,
          commandId: crypto.randomUUID(),
        }, projectId, signal);
        await refresh(lifecycle.dataset.lifecycle === "archive" ? "Project archived." : "Project unarchived.");
      }
    } catch (error) {
      failure = errorMessage(error);
      render();
    }
  }, { signal });

  render();
}

export const workspacesFeature: WebFeature = {
  id: "workspaces",
  label: "Workspaces",
  path: "/workspaces",
  title: "Workspaces",
  routes: ["home", "workspaces", "attention", "workspace", "project"],
  async mount(context) {
    if (context.route.id === "workspace") {
      await renderWorkspaceDetail(
        context,
        context.route.params.container,
        context.route.params.module,
      );
      return;
    }
    if (context.route.id === "project") {
      await renderProject(
        context,
        context.route.params.container,
        context.route.params.module,
        context.route.params.project,
      );
      return;
    }
    if (context.route.id === "attention") {
      await renderAttention(context);
      return;
    }
    await renderWorkspaceCollection(context);
  },
};
