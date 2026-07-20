import type { WebFeature } from "./feature.js";
import { browseFeature } from "./features/browse.js";
import { todosFeature } from "./features/todos.js";
import { workspacesFeature } from "./features/workspaces.js";
import { agentsFeature } from "./features/agents.js";
import { errorMessage, escapeHtml } from "./dom.js";
import { matchRoute, type AppRoute } from "./routing.js";

const navNode = document.getElementById("feature-nav");
const rootNode = document.getElementById("feature-root");
const statusNode = document.getElementById("global-status");
if (!(navNode instanceof HTMLElement) || !(rootNode instanceof HTMLElement) || !(statusNode instanceof HTMLElement)) {
  throw new Error("Web app shell is missing required elements.");
}
const nav = navNode;
const root = rootNode;
const status = statusNode;

const features: WebFeature[] = [workspacesFeature, browseFeature, todosFeature, agentsFeature];
const notFoundFeature: WebFeature = {
  id: "not-found",
  label: "Not found",
  path: "",
  title: "Not found",
  routes: ["not-found"],
  mount({ root, setStatus }) {
    root.innerHTML = `
      <section class="feature">
        <div class="panel empty-state">
          <div>
            <h1>Page not found</h1>
            <p>The requested Open Knowledge Hub page does not exist.</p>
            <a class="primary-button button-link" data-route href="/workspaces">Go to workspaces</a>
          </div>
        </div>
      </section>
    `;
    setStatus("Page not found");
  },
};
let routeController: AbortController | undefined;

function currentFeature(route: AppRoute): WebFeature {
  return features.find((feature) => feature.routes.includes(route.id)) ?? notFoundFeature;
}

function renderNav(active: WebFeature): void {
  nav.innerHTML = features.map((feature) => `
    <a
      class="feature-link"
      href="${feature.path}"
      data-route
      ${feature.id === active.id ? 'aria-current="page"' : ""}
    >${escapeHtml(feature.label)}</a>
  `).join("");
}

async function renderRoute(): Promise<void> {
  const route = matchRoute(window.location.pathname);
  const feature = currentFeature(route);
  routeController?.abort();
  routeController = new AbortController();
  const { signal } = routeController;
  renderNav(feature);
  document.title = `${feature.title} - Open Knowledge Hub`;
  status.textContent = "Loading";
  root.innerHTML = '<div class="panel loading-state">Loading feature...</div>';
  try {
    await feature.mount({
      root,
      signal,
      setStatus(message) {
        if (!signal.aborted) status.textContent = message;
      },
      route,
    });
    if (!signal.aborted) root.focus({ preventScroll: true });
  } catch (error: unknown) {
    if (signal.aborted) return;
    status.textContent = "Feature failed";
    root.innerHTML = `<div class="banner banner-error" role="alert">${escapeHtml(errorMessage(error))}</div>`;
  }
}

document.addEventListener("click", (event) => {
  if (
    event.defaultPrevented
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey
    || !(event.target instanceof Element)
  ) {
    return;
  }
  const link = event.target.closest<HTMLAnchorElement>("a[data-route]");
  if (!link || link.origin !== window.location.origin) return;
  event.preventDefault();
  history.pushState(null, "", `${link.pathname}${link.search}${link.hash}`);
  void renderRoute();
});

window.addEventListener("popstate", () => {
  void renderRoute();
});

await renderRoute();
