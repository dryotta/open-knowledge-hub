import type {
  ReadResourceResult,
  Resource,
  ResourceLink,
} from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ContainerService,
  ResolvedContainer,
  ResolvedModule,
} from "../container/service.js";
import { isOkhError } from "../errors.js";
import { formatSyncDescriptor } from "../util/syncFormat.js";
import {
  listModuleFiles,
  MAX_RESOURCE_FILE_BYTES,
  moduleFileMetadata,
  readModuleFile,
} from "./moduleFiles.js";
import type {
  ResourceProvider,
  ResourceReadOptions,
} from "./types.js";
import {
  CONTAINER_URI_TEMPLATE,
  CONTAINERS_URI,
  MODULE_FILE_URI_TEMPLATE,
  MODULE_URI_TEMPLATE,
  containerUri,
  moduleFileUri,
  moduleUri,
  parseContainerResourceUri,
} from "./uris.js";

const RESOURCE_NOT_FOUND = -32002;
const COMMON_ANNOTATIONS = {
  audience: ["user", "assistant"] as Array<"user" | "assistant">,
};
const INDEX_OVERVIEW_TYPES = new Set(["knowledge", "llmwiki", "skills"]);
export const MAX_MODULE_OVERVIEW_BYTES = 256 * 1024;
export const MAX_MODULE_RESOURCE_BYTES = 512 * 1024;
const MAX_MODULE_DESCRIPTION_BYTES = 4 * 1024;

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

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = maxBytes >= 3 ? "..." : ".".repeat(maxBytes);
  const contentLimit = maxBytes - Buffer.byteLength(suffix);
  let bytes = 0;
  let truncated = "";
  for (const character of value) {
    const width = Buffer.byteLength(character);
    if (bytes + width > contentLimit) break;
    truncated += character;
    bytes += width;
  }
  return `${truncated}${suffix}`;
}

function enforceReadLimit(
  result: ReadResourceResult,
  maxBytes: number | undefined,
): ReadResourceResult {
  if (maxBytes === undefined) return result;
  const size = result.contents.reduce(
    (total, content) => total + Buffer.byteLength(
      "text" in content ? content.text : content.blob,
      "text" in content ? "utf8" : "ascii",
    ),
    0,
  );
  if (size > maxBytes) {
    throw new McpError(
      -32602,
      `Resource is ${size} bytes; the maximum readable size is ${maxBytes} bytes.`,
    );
  }
  return result;
}

function containersResource(): Resource {
  return {
    uri: CONTAINERS_URI,
    name: "containers",
    title: "Containers",
    description: "Browse registered containers and their modules.",
    mimeType: "text/markdown",
    annotations: { ...COMMON_ANNOTATIONS, priority: 1 },
  };
}

function toResourceLink(resource: Resource): ResourceLink {
  return { type: "resource_link", ...resource };
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
  const listing = await listModuleFiles(module.absPath);
  const { files } = listing;
  const overviewCandidates = INDEX_OVERVIEW_TYPES.has(module.type)
    ? ["index.md", "README.md"]
    : ["README.md", "index.md"];
  let overview = "_No overview file._";
  for (const overviewPath of overviewCandidates) {
    const overviewUri = moduleFileUri(container.name, module.path, overviewPath);
    try {
      const metadata = await moduleFileMetadata(module.absPath, overviewPath, overviewUri);
      if (metadata.size > MAX_MODULE_OVERVIEW_BYTES) {
        overview = metadata.size <= MAX_RESOURCE_FILE_BYTES
          ? `_Overview omitted because it exceeds ${MAX_MODULE_OVERVIEW_BYTES} bytes;`
            + ` read [${overviewPath}](<${overviewUri}>) directly._`
          : `_Overview omitted because it exceeds both the ${MAX_MODULE_OVERVIEW_BYTES}-byte`
            + " overview limit and the direct resource-read limit._";
      } else {
        const payload = await readModuleFile(
          module.absPath,
          overviewPath,
          overviewUri,
          MAX_MODULE_OVERVIEW_BYTES,
        );
        overview = payload.text === undefined
          ? `_Overview omitted because ${overviewPath} is not valid UTF-8; read it directly._`
          : payload.text.trim() || "_Overview file is empty._";
      }
      break;
    } catch (error) {
      if (error instanceof McpError && error.code === RESOURCE_NOT_FOUND) continue;
      if (error instanceof McpError && error.code === -32602) {
        overview = `_Overview omitted because it exceeded ${MAX_MODULE_OVERVIEW_BYTES} bytes while being read._`;
        break;
      }
      if (error instanceof McpError && error.code === -32603) {
        overview = `_Overview file ${overviewPath} cannot be read._`;
        break;
      }
      throw error;
    }
  }
  const description = truncateUtf8(module.description || "(none)", MAX_MODULE_DESCRIPTION_BYTES);
  const lines = [
    `# Module: ${markdownLabel(module.path)}`,
    "",
    `- Container: ${resourceLink(container.name, containerUri(container.name))}`,
    `- Type: ${module.type}`,
    `- Description: ${description}`,
    "",
    "## Overview",
    "",
    overview,
    "",
    "## Files",
    "",
  ];
  const fileSectionStart = lines.length;
  let renderedBytes = Buffer.byteLength(`${lines.join("\n")}\n`);
  let outputTruncated = listing.truncated;
  if (files.length === 0) {
    const line = "_No visible files._";
    lines.push(line);
    renderedBytes += Buffer.byteLength(`${line}\n`);
  } else {
    for (const path of files) {
      const line = `- ${resourceLink(path, moduleFileUri(container.name, module.path, path))}`;
      const lineBytes = Buffer.byteLength(`${line}\n`);
      if (renderedBytes + lineBytes > MAX_MODULE_RESOURCE_BYTES) {
        outputTruncated = true;
        break;
      }
      lines.push(line);
      renderedBytes += lineBytes;
    }
  }
  if (outputTruncated) {
    const marker =
      `_File list truncated to keep this resource below ${MAX_MODULE_RESOURCE_BYTES} bytes;`
      + " read known file URIs directly._";
    const markerBytes = Buffer.byteLength(`${marker}\n`);
    while (
      renderedBytes + markerBytes > MAX_MODULE_RESOURCE_BYTES
      && lines.length > fileSectionStart
    ) {
      renderedBytes -= Buffer.byteLength(`${lines.pop()!}\n`);
    }
    lines.push(marker);
  }
  const rendered = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(rendered) <= MAX_MODULE_RESOURCE_BYTES) return rendered;

  const marker = "\n\n_Resource truncated to the module response limit._\n";
  return `${truncateUtf8(
    rendered,
    MAX_MODULE_RESOURCE_BYTES - Buffer.byteLength(marker),
  )}${marker}`;
}

export class ContainerResourceProvider implements ResourceProvider {
  readonly id = "containers";

  constructor(private readonly service: ContainerService) {}

  async read(
    uriText: string,
    options: ResourceReadOptions = {},
  ): Promise<ReadResourceResult | undefined> {
    const location = parseContainerResourceUri(uriText);
    if (!location) return undefined;

    const uri = new URL(uriText);
    if (location.kind === "root") {
      return enforceReadLimit({
        contents: [{
          uri: uriText,
          mimeType: "text/markdown",
          text: renderContainerIndex(await this.service.resolveTargets()),
        }],
      }, options.maxBytes);
    }

    if (location.kind === "container") {
      const container = await resolveContainer(this.service, uri, location.container);
      return enforceReadLimit({
        contents: [{
          uri: uriText,
          mimeType: "text/markdown",
          text: renderContainer(container),
        }],
      }, options.maxBytes);
    }

    const { container, module } = await resolveModule(
      this.service,
      uri,
      location.container,
      location.module,
    );
    if (location.kind === "module") {
      return enforceReadLimit({
        contents: [{
          uri: uriText,
          mimeType: "text/markdown",
          text: await renderModule(container, module),
        }],
      }, options.maxBytes);
    }

    const payload = await readModuleFile(
      module.absPath,
      location.path,
      uriText,
      options.maxBytes,
    );
    return enforceReadLimit({
      contents: [{
        uri: uriText,
        mimeType: payload.mimeType,
        ...(payload.text !== undefined ? { text: payload.text } : { blob: payload.blob! }),
      }],
    }, options.maxBytes);
  }

  private async requireRead(uri: URL): Promise<ReadResourceResult> {
    const result = await this.read(uri.toString());
    if (!result) throw notFound(uri);
    return result;
  }

  async resolveLink(uriText: string): Promise<ResourceLink | undefined> {
    const location = parseContainerResourceUri(uriText);
    if (!location) return undefined;
    if (location.kind === "root") return toResourceLink(containersResource());

    const uri = new URL(uriText);
    try {
      if (location.kind === "container") {
        return toResourceLink(
          containerResource(await resolveContainer(this.service, uri, location.container)),
        );
      }

      const { container, module } = await resolveModule(
        this.service,
        uri,
        location.container,
        location.module,
      );
      if (location.kind === "module") {
        return toResourceLink(moduleResource(container, module));
      }

      const metadata = await moduleFileMetadata(module.absPath, location.path, uriText);
      if (metadata.size > MAX_RESOURCE_FILE_BYTES) return undefined;
      return {
        type: "resource_link",
        uri: uriText,
        name: `file/${location.container}/${location.module}/${location.path}`,
        title: location.path,
        description: `File in module "${location.module}" of container "${location.container}".`,
        mimeType: metadata.mimeType,
        size: metadata.size,
        annotations: {
          ...COMMON_ANNOTATIONS,
          priority: 0.6,
          lastModified: metadata.lastModified,
        },
      };
    } catch (error) {
      if (
        error instanceof McpError
        && (
          error.code === RESOURCE_NOT_FOUND
          || error.code === -32602
          || error.code === -32603
        )
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async register(server: McpServer): Promise<void> {
    const root = containersResource();
    server.registerResource(
      root.name,
      root.uri,
      {
        title: root.title,
        description: root.description,
        mimeType: root.mimeType,
        annotations: root.annotations,
      },
      async (uri) => this.requireRead(uri),
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
      async (uri) => this.requireRead(uri),
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
      async (uri) => this.requireRead(uri),
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
              return (await listModuleFiles(module.absPath, {
                maxFiles: 500,
                maxEntries: 5_000,
              })).files
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
      async (uri) => this.requireRead(uri),
    );
  }
}
