import type { WebFeature } from "./feature.js";
import { browseFeature } from "./features/browse.js";
import { todosFeature } from "./features/todos.js";
import { errorMessage, escapeHtml } from "./dom.js";

const navNode = document.getElementById("feature-nav");
const rootNode = document.getElementById("feature-root");
const statusNode = document.getElementById("global-status");
if (!(navNode instanceof HTMLElement) || !(rootNode instanceof HTMLElement) || !(statusNode instanceof HTMLElement)) {
  throw new Error("Web app shell is missing required elements.");
}
const nav = navNode;
const root = rootNode;
const status = statusNode;

const features: WebFeature[] = [browseFeature, todosFeature];
let routeController: AbortController | undefined;

function currentFeature(): WebFeature {
  return features.find((feature) => feature.path === window.location.pathname) ?? browseFeature;
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
  const feature = currentFeature();
  if (window.location.pathname !== feature.path) {
    history.replaceState(null, "", feature.path);
  }
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
  history.pushState(null, "", link.pathname);
  void renderRoute();
});

window.addEventListener("popstate", () => {
  void renderRoute();
});

await renderRoute();
