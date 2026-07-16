import { getContainers, getDirectory, getFile } from "../api.js";
import { errorMessage, escapeHtml, formatBytes } from "../dom.js";
import type { WebFeature } from "../feature.js";
import type {
  WebContainerSummary,
  WebDirectoryResponse,
  WebFileResponse,
  WebModuleSummary,
} from "../../../src/web/types.js";

interface SelectedModule {
  container: WebContainerSummary;
  module: WebModuleSummary;
}

export const browseFeature: WebFeature = {
  id: "browse",
  label: "Browse",
  path: "/browse",
  title: "Browse containers",
  async mount({ root, signal, setStatus }) {
    root.innerHTML = `
      <section class="feature">
        <header class="feature-heading">
          <div>
            <h1>Containers</h1>
            <p>Browse registered modules and preview their files.</p>
          </div>
          <button class="secondary-button" type="button" data-action="refresh-containers">Refresh</button>
        </header>
        <div id="browse-error" class="banner banner-error" hidden></div>
        <div class="browser-grid">
          <aside class="panel">
            <div class="panel-header"><h2>Containers and modules</h2></div>
            <div id="module-list" class="panel-body"><div class="loading-state">Loading containers...</div></div>
          </aside>
          <section class="panel">
            <div class="panel-header">
              <div id="directory-title" class="breadcrumbs"><span class="muted">Select a module</span></div>
            </div>
            <div id="file-list" class="panel-body"><div class="empty-state">Choose a module to browse files.</div></div>
          </section>
          <section class="panel preview-panel">
            <div class="panel-header preview-header">
              <div>
                <h2 id="preview-name">File preview</h2>
                <div id="preview-path" class="preview-path">Select a text file.</div>
              </div>
              <span id="preview-size" class="file-meta"></span>
            </div>
            <pre id="file-preview" class="file-preview"><code>Select a file to preview its contents.</code></pre>
          </section>
        </div>
      </section>
    `;

    const moduleListNode = root.querySelector<HTMLElement>("#module-list");
    const fileListNode = root.querySelector<HTMLElement>("#file-list");
    const directoryTitleNode = root.querySelector<HTMLElement>("#directory-title");
    const previewNameNode = root.querySelector<HTMLElement>("#preview-name");
    const previewPathNode = root.querySelector<HTMLElement>("#preview-path");
    const previewSizeNode = root.querySelector<HTMLElement>("#preview-size");
    const previewNode = root.querySelector<HTMLElement>("#file-preview code");
    const errorBannerNode = root.querySelector<HTMLElement>("#browse-error");
    if (!moduleListNode || !fileListNode || !directoryTitleNode || !previewNameNode || !previewPathNode || !previewSizeNode || !previewNode || !errorBannerNode) {
      throw new Error("Browse UI is missing required elements.");
    }
    const moduleList = moduleListNode;
    const fileList = fileListNode;
    const directoryTitle = directoryTitleNode;
    const previewName = previewNameNode;
    const previewPath = previewPathNode;
    const previewSize = previewSizeNode;
    const preview = previewNode;
    const errorBanner = errorBannerNode;

    let containers: WebContainerSummary[] = [];
    let selected: SelectedModule | undefined;
    let directory: WebDirectoryResponse | undefined;
    let directoryRequest = 0;
    let fileRequest = 0;

    function showError(message = ""): void {
      errorBanner.hidden = message.length === 0;
      errorBanner.textContent = message;
    }

    function renderModules(): void {
      if (containers.length === 0) {
        moduleList.innerHTML = '<div class="empty-state">No containers are registered.</div>';
        return;
      }
      moduleList.innerHTML = containers.map((container) => `
        <section class="container-group">
          <div class="container-title">
            <strong>${escapeHtml(container.name)}</strong>
            <span class="container-meta">${escapeHtml(container.backend)} / ${container.moduleCount}</span>
          </div>
          <ul class="module-list">
            ${container.modules.length === 0
              ? '<li class="module-meta">No modules</li>'
              : container.modules.map((module) => {
                const active = selected?.container.name === container.name && selected.module.path === module.path;
                return `
                  <li>
                    <button
                      class="module-button"
                      type="button"
                      data-container="${escapeHtml(container.name)}"
                      data-module="${escapeHtml(module.path)}"
                      aria-current="${active}"
                    >
                      <strong>${escapeHtml(module.path)}</strong>
                      <span class="module-meta">${escapeHtml(module.type)}</span>
                    </button>
                  </li>
                `;
              }).join("")}
          </ul>
        </section>
      `).join("");
    }

    function renderBreadcrumbs(path: string): void {
      const segments = path ? path.split("/") : [];
      let current = "";
      const crumbs = [
        '<button class="breadcrumb-button" type="button" data-directory="">root</button>',
      ];
      for (const segment of segments) {
        current = current ? `${current}/${segment}` : segment;
        crumbs.push(
          '<span class="muted">/</span>',
          `<button class="breadcrumb-button" type="button" data-directory="${escapeHtml(current)}">${escapeHtml(segment)}</button>`,
        );
      }
      directoryTitle.innerHTML = crumbs.join("");
    }

    function renderDirectory(): void {
      if (!directory) {
        fileList.innerHTML = '<div class="empty-state">Choose a module to browse files.</div>';
        directoryTitle.innerHTML = '<span class="muted">Select a module</span>';
        return;
      }
      renderBreadcrumbs(directory.path);
      if (directory.entries.length === 0) {
        fileList.innerHTML = '<div class="empty-state">This directory is empty.</div>';
        return;
      }
      fileList.innerHTML = `
        <ul class="file-list">
          ${directory.entries.map((entry) => `
            <li>
              <button
                class="file-button"
                type="button"
                data-${entry.kind === "directory" ? "directory" : "file"}="${escapeHtml(entry.path)}"
              >
                <span class="file-kind">${entry.kind === "directory" ? "DIR" : "FILE"}</span>
                <span class="file-name">${escapeHtml(entry.name)}</span>
                <span class="file-meta">${entry.size === undefined ? "" : formatBytes(entry.size)}</span>
              </button>
            </li>
          `).join("")}
        </ul>
      `;
    }

    function renderFile(file: WebFileResponse): void {
      previewName.textContent = file.path.split("/").at(-1) ?? file.path;
      previewPath.textContent = `${file.container}/${file.module}/${file.path}`;
      previewSize.textContent = formatBytes(file.size);
      preview.textContent = file.content;
    }

    function resetPreview(path = "Select a text file."): void {
      previewName.textContent = "File preview";
      previewPath.textContent = path;
      previewSize.textContent = "";
      preview.textContent = "Select a file to preview its contents.";
    }

    async function loadDirectory(path: string): Promise<void> {
      if (!selected) return;
      const request = ++directoryRequest;
      fileList.innerHTML = '<div class="loading-state">Loading files...</div>';
      setStatus(`Loading ${selected.container.name}/${selected.module.path}`);
      showError();
      try {
        const result = await getDirectory(selected.container.name, selected.module.path, path, signal);
        if (request !== directoryRequest) return;
        directory = result;
        renderDirectory();
        setStatus(`${result.entries.length} entries`);
      } catch (error: unknown) {
        if (signal.aborted || request !== directoryRequest) return;
        fileList.innerHTML = '<div class="empty-state">Could not load this directory.</div>';
        showError(errorMessage(error));
        setStatus("Directory load failed");
      }
    }

    async function loadFile(path: string): Promise<void> {
      if (!selected) return;
      const request = ++fileRequest;
      previewName.textContent = path.split("/").at(-1) ?? path;
      previewPath.textContent = `${selected.container.name}/${selected.module.path}/${path}`;
      previewSize.textContent = "";
      preview.textContent = "Loading file...";
      setStatus(`Loading ${path}`);
      showError();
      try {
        const result = await getFile(selected.container.name, selected.module.path, path, signal);
        if (request !== fileRequest) return;
        renderFile(result);
        setStatus(`${result.path} / ${formatBytes(result.size)}`);
      } catch (error: unknown) {
        if (signal.aborted || request !== fileRequest) return;
        preview.textContent = "This file could not be previewed.";
        showError(errorMessage(error));
        setStatus("File preview failed");
      }
    }

    async function selectModule(containerName: string, modulePath: string): Promise<void> {
      const container = containers.find((candidate) => candidate.name === containerName);
      const module = container?.modules.find((candidate) => candidate.path === modulePath);
      if (!container || !module) return;
      selected = { container, module };
      directory = undefined;
      fileRequest++;
      renderModules();
      resetPreview(`${container.name}/${module.path}`);
      await loadDirectory("");
    }

    async function loadContainers(): Promise<void> {
      moduleList.innerHTML = '<div class="loading-state">Loading containers...</div>';
      showError();
      setStatus("Loading containers");
      try {
        const result = await getContainers(signal);
        containers = result.containers;
        if (selected) {
          const nextContainer = containers.find((candidate) => candidate.name === selected?.container.name);
          const nextModule = nextContainer?.modules.find((candidate) => candidate.path === selected?.module.path);
          selected = nextContainer && nextModule ? { container: nextContainer, module: nextModule } : undefined;
        }
        if (!selected) {
          directory = undefined;
          fileRequest++;
          renderDirectory();
          resetPreview();
        }
        renderModules();
        setStatus(`${containers.length} container${containers.length === 1 ? "" : "s"}`);
        const firstContainer = containers.find((container) => container.modules.length > 0);
        const firstModule = firstContainer?.modules[0];
        if (!selected && firstContainer && firstModule) {
          await selectModule(firstContainer.name, firstModule.path);
        } else if (selected) {
          await loadDirectory(directory?.path ?? "");
        }
      } catch (error: unknown) {
        if (signal.aborted) return;
        containers = [];
        renderModules();
        showError(errorMessage(error));
        setStatus("Container load failed");
      }
    }

    root.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const control = event.target.closest<HTMLElement>("[data-action], [data-container][data-module], [data-directory], [data-file]");
      if (!control) return;
      if (control.dataset.action === "refresh-containers") {
        void loadContainers();
        return;
      }
      const container = control.dataset.container;
      const module = control.dataset.module;
      if (container !== undefined && module !== undefined) {
        void selectModule(container, module);
        return;
      }
      if (control.dataset.directory !== undefined) {
        void loadDirectory(control.dataset.directory);
        return;
      }
      if (control.dataset.file !== undefined) {
        void loadFile(control.dataset.file);
      }
    }, { signal });

    await loadContainers();
  },
};
