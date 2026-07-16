import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ContainerService,
  ResolvedContainer,
  ResolvedModule,
} from "../container/service.js";
import { isOkhError } from "../errors.js";
import { formatSyncDescriptor } from "../util/syncFormat.js";
import { listModuleFiles, readModuleFile } from "./moduleFiles.js";
import type { ResourceProvider } from "./types.js";
import {
  CONTAINER_URI_TEMPLATE,
  CONTAINERS_URI,
  MODULE_FILE_URI_TEMPLATE,
  MODULE_URI_TEMPLATE,
  containerUri,
  decodeTemplateValue,
  moduleFileUri,
  moduleUri,
} from "./uris.js";

const RESOURCE_NOT_FOUND = -32002;
const COMMON_ANNOTATIONS = {
  audience: ["user", "assistant"] as Array<"user" | "assistant">,
};
const INDEX_OVERVIEW_TYPES = new Set(["knowledge", "llmwiki", "skills"]);

function notFound(uri: URL): McpError {
  return new McpError(RESOURCE_NOT_FOUND, `Resource not found: ${uri.toString()}`);
}

function translateNotFound(uri: URL, error: unknown): never {
  if (isOkhError(error) && error.code === "NOT_FOUND") throw notFound(uri);
  throw error;
}

function unavailableForCompletion(error: unknown): boolean {
  return (isOkhError(error) && error.code === "NOT_FOUND")
    || (error instanceof McpError && error.code === RESOURCE_NOT_FOUND);
}

function markdownLabel(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/\[/gu, "\\[")
    .replace(/\]/gu, "\\]")
    .replace(/[\r\n]+/gu, " ");
}

function resourceLink(label: string, uri: string): string {
  return `[${markdownLabel(label)}](<${uri}>)`;
}

function containerResource(container: ResolvedContainer): Resource {
  return {
    uri: containerUri(container.name),
    name: `container/${container.name}`,
    title: container.name,
    description: `${container.backend} container with ${container.modules.length} module(s).`,
    mimeType: "text/markdown",
    annotations: { ...COMMON_ANNOTATIONS, priority: 0.8 },
  };
}

function moduleResource(container: ResolvedContainer, module: ResolvedModule): Resource {
  return {
    uri: moduleUri(container.name, module.path),
    name: `module/${container.name}/${module.path}`,
    title: module.path,
    description: module.description || `${module.type} module`,
    mimeType: "text/markdown",
    annotations: { ...COMMON_ANNOTATIONS, priority: 0.7 },
  };
}

async function resolveContainer(
  service: ContainerService,
  uri: URL,
  name: string,
): Promise<ResolvedContainer> {
  try {
    const target = (await service.resolveTargets(name))[0];
    if (!target) throw notFound(uri);
    return target;
  } catch (error) {
    translateNotFound(uri, error);
  }
}

async function resolveModule(
  service: ContainerService,
  uri: URL,
  containerName: string,
  moduleName: string,
): Promise<{ container: ResolvedContainer; module: ResolvedModule }> {
  try {
    const container = (await service.resolveTargets(containerName, moduleName))[0];
    const module = container?.modules.find((candidate) => candidate.path === moduleName);
    if (!container || !module) throw notFound(uri);
    return { container, module };
  } catch (error) {
    translateNotFound(uri, error);
  }
}

function renderContainerIndex(containers: ResolvedContainer[]): string {
  const lines = [
    "# Containers",
    "",
    "Canonical documentation: [documentation index](okh://docs/index.md)",
    "",
    "Reusable built-in guidance: [common instructions](okh://instructions/index.md)",
    "",
    "## Containers",
    "",
  ];
  if (containers.length === 0) {
    lines.push("_No containers are registered._");
  } else {
    for (const container of containers) {
      lines.push(
        `- ${resourceLink(container.name, containerUri(container.name))}`
        + ` — ${container.backend}, ${formatSyncDescriptor(container.sync)},`
        + ` ${container.modules.length} module(s)`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderContainer(container: ResolvedContainer): string {
  const lines = [
    `# Container: ${markdownLabel(container.name)}`,
    "",
    `- Backend: ${container.backend}`,
    `- Sync: ${formatSyncDescriptor(container.sync)}`,
    "",
    "## Modules",
    "",
  ];
  if (container.modules.length === 0) {
    lines.push("_No modules._");
  } else {
    for (const module of container.modules) {
      lines.push(
        `- ${resourceLink(module.path, moduleUri(container.name, module.path))}`
        + ` — ${module.type}${module.description ? `: ${module.description}` : ""}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function renderModule(
  container: ResolvedContainer,
  module: ResolvedModule,
): Promise<string> {
  const files = await listModuleFiles(module.absPath);
  const overviewCandidates = INDEX_OVERVIEW_TYPES.has(module.type)
    ? ["index.md", "README.md"]
    : ["README.md", "index.md"];
  const overviewPath = overviewCandidates.find((path) => files.includes(path));
  let overview = "_No overview file._";
  if (overviewPath) {
    const overviewUri = moduleFileUri(container.name, module.path, overviewPath);
    const payload = await readModuleFile(module.absPath, overviewPath, overviewUri);
    overview = payload.text?.trim() || "_Overview file is empty._";
  }
  const lines = [
    `# Module: ${markdownLabel(module.path)}`,
    "",
    `- Container: ${resourceLink(container.name, containerUri(container.name))}`,
    `- Type: ${module.type}`,
    `- Description: ${module.description || "(none)"}`,
    "",
    "## Overview",
    "",
    overview,
    "",
    "## Files",
    "",
  ];
  if (files.length === 0) {
    lines.push("_No visible files._");
  } else {
    for (const path of files) {
      lines.push(`- ${resourceLink(path, moduleFileUri(container.name, module.path, path))}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export class ContainerResourceProvider implements ResourceProvider {
  readonly id = "containers";

  constructor(private readonly service: ContainerService) {}

  async register(server: McpServer): Promise<void> {
    server.registerResource(
      "containers",
      CONTAINERS_URI,
      {
        title: "Containers",
        description: "Browse registered containers and their modules.",
        mimeType: "text/markdown",
        annotations: { ...COMMON_ANNOTATIONS, priority: 1 },
      },
      async (uri) => ({
        contents: [{
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: renderContainerIndex(await this.service.resolveTargets()),
          annotations: { ...COMMON_ANNOTATIONS, priority: 1 },
        }],
      }),
    );

    server.registerResource(
      "container",
      new ResourceTemplate(CONTAINER_URI_TEMPLATE, {
        list: async () => ({
          resources: (await this.service.resolveTargets()).map(containerResource),
        }),
        complete: {
          container: async (value) => (await this.service.resolveTargets())
            .map((container) => container.name)
            .filter((name) => name.startsWith(value)),
        },
      }),
      {
        title: "Hub container",
        description: "A registered OKH container and its modules.",
        mimeType: "text/markdown",
        annotations: { ...COMMON_ANNOTATIONS, priority: 0.8 },
      },
      async (uri, variables) => {
        const name = decodeTemplateValue(variables["container"], uri);
        const container = await resolveContainer(this.service, uri, name);
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: "text/markdown",
            text: renderContainer(container),
            annotations: { ...COMMON_ANNOTATIONS, priority: 0.8 },
          }],
        };
      },
    );

    server.registerResource(
      "container-module",
      new ResourceTemplate(MODULE_URI_TEMPLATE, {
        list: async () => ({
          resources: (await this.service.resolveTargets()).flatMap((container) =>
            container.modules.map((module) => moduleResource(container, module))),
        }),
        complete: {
          container: async (value) => (await this.service.resolveTargets())
            .map((container) => container.name)
            .filter((name) => name.startsWith(value)),
          module: async (value, context) => {
            const containerName = context?.arguments?.["container"];
            if (typeof containerName !== "string") return [];
            try {
              const container = (await this.service.resolveTargets(containerName))[0];
              return (container?.modules ?? [])
                .map((module) => module.path)
                .filter((path) => path.startsWith(value));
            } catch (error) {
              if (unavailableForCompletion(error)) return [];
              throw error;
            }
          },
        },
      }),
      {
        title: "Hub module",
        description: "A module overview plus links to every visible module file.",
        mimeType: "text/markdown",
        annotations: { ...COMMON_ANNOTATIONS, priority: 0.7 },
      },
      async (uri, variables) => {
        const containerName = decodeTemplateValue(variables["container"], uri);
        const moduleName = decodeTemplateValue(variables["module"], uri);
        const { container, module } = await resolveModule(
          this.service,
          uri,
          containerName,
          moduleName,
        );
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: "text/markdown",
            text: await renderModule(container, module),
            annotations: { ...COMMON_ANNOTATIONS, priority: 0.7 },
          }],
        };
      },
    );

    server.registerResource(
      "container-module-file",
      new ResourceTemplate(MODULE_FILE_URI_TEMPLATE, {
        list: undefined,
        complete: {
          path: async (value, context) => {
            const containerName = context?.arguments?.["container"];
            const moduleName = context?.arguments?.["module"];
            if (typeof containerName !== "string" || typeof moduleName !== "string") return [];
            try {
              const target = (await this.service.resolveTargets(containerName, moduleName))[0];
              const module = target?.modules.find((candidate) => candidate.path === moduleName);
              if (!module) return [];
              return (await listModuleFiles(module.absPath))
                .filter((path) => path.startsWith(value))
                .slice(0, 100);
            } catch (error) {
              if (unavailableForCompletion(error)) return [];
              throw error;
            }
          },
        },
      }),
      {
        title: "Hub module file",
        description: "Read one visible file within a registered module.",
        mimeType: "application/octet-stream",
        annotations: { ...COMMON_ANNOTATIONS, priority: 0.6 },
      },
      async (uri, variables) => {
        const containerName = decodeTemplateValue(variables["container"], uri);
        const moduleName = decodeTemplateValue(variables["module"], uri);
        const path = decodeTemplateValue(variables["path"], uri);
        const { module } = await resolveModule(this.service, uri, containerName, moduleName);
        const payload = await readModuleFile(module.absPath, path, uri.toString());
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: payload.mimeType,
            ...(payload.text !== undefined ? { text: payload.text } : { blob: payload.blob! }),
            annotations: {
              ...COMMON_ANNOTATIONS,
              priority: 0.6,
              lastModified: payload.lastModified,
            },
          }],
        };
      },
    );
  }
}
