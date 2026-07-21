import { getAgents } from "../api.js";
import { escapeHtml } from "../dom.js";
import type { WebFeature } from "../feature.js";
import { workspacePath } from "../routing.js";

export const agentsFeature: WebFeature = {
  id: "agents",
  label: "Agents",
  path: "/agents",
  title: "Agents",
  routes: ["agents"],
  async mount({ root, signal, setStatus }) {
    const response = await getAgents(signal);
    root.innerHTML = `
      <section class="feature">
        <header class="feature-heading">
          <div>
            <h1>Agents</h1>
            <p>Regular OKH agents available to workspace leads and pools.</p>
          </div>
        </header>
        ${response.issues.length
          ? `<div class="banner banner-warning">${response.issues.map(escapeHtml).join("<br>")}</div>`
          : ""}
        <div class="agent-grid">
          ${response.agents.length
            ? response.agents.map((agent) => {
                const query = new URLSearchParams({
                  container: agent.container,
                  module: agent.module,
                  path: agent.path,
                });
                return `
                  <article class="panel agent-card">
                    <div class="panel-header">
                      <h2>${escapeHtml(agent.id)}</h2>
                      <a target="_blank" rel="noreferrer" href="/api/file?${query.toString()}">Profile</a>
                    </div>
                    <div class="panel-body">
                      <p>${escapeHtml(agent.description || "No description")}</p>
                      <div class="card-meta">
                        <span>${escapeHtml(agent.container)}/${escapeHtml(agent.module)}</span>
                      </div>
                      <h3>Workspace references</h3>
                      ${agent.referencedBy.length
                        ? `<ul class="reference-list">${agent.referencedBy.map((reference) => `
                            <li>
                              <a data-route href="${workspacePath(reference.container, reference.module)}">
                                ${escapeHtml(reference.container)}/${escapeHtml(reference.module)}
                              </a>
                              <span class="badge">${escapeHtml(reference.role)}</span>
                            </li>
                          `).join("")}</ul>`
                        : '<p class="muted">Not currently referenced.</p>'}
                    </div>
                  </article>
                `;
              }).join("")
            : '<div class="panel empty-state">No agent profiles are available.</div>'}
        </div>
      </section>
    `;
    setStatus(`${response.agents.length} agent${response.agents.length === 1 ? "" : "s"}`);
  },
};
