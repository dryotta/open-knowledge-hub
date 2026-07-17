import { McpError } from "@modelcontextprotocol/sdk/types.js";

export const CONTAINERS_URI = "okh://containers";
export const DOCS_URI_PREFIX = "okh://docs";
export const INSTRUCTIONS_URI_PREFIX = "okh://instructions";

export const CONTAINER_URI_TEMPLATE = `${CONTAINERS_URI}/{container}`;
export const MODULE_URI_TEMPLATE = `${CONTAINERS_URI}/{container}/{module}`;
export const MODULE_FILE_URI_TEMPLATE =
  `${CONTAINERS_URI}/{container}/{module}/files/{path}`;

export type ContainerResourceLocation =
  | { kind: "root" }
  | { kind: "container"; container: string }
  | { kind: "module"; container: string; module: string }
  | { kind: "file"; container: string; module: string; path: string };

export function encodeUriSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function containerUri(container: string): string {
  return `${CONTAINERS_URI}/${encodeUriSegment(container)}`;
}

export function moduleUri(container: string, module: string): string {
  return `${containerUri(container)}/${encodeUriSegment(module)}`;
}

export function moduleFileUri(container: string, module: string, path: string): string {
  return `${moduleUri(container, module)}/files/${encodeUriSegment(path)}`;
}

export function parseContainerResourceUri(value: string): ContainerResourceLocation | undefined {
  if (value === CONTAINERS_URI) return { kind: "root" };
  if (!value.startsWith(`${CONTAINERS_URI}/`)) return undefined;

  const encoded = value.slice(CONTAINERS_URI.length + 1).split("/");
  if (encoded.some((segment) => segment.length === 0)) return undefined;
  let segments: string[];
  try {
    segments = encoded.map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }

  if (segments.length === 1) {
    const location = { kind: "container" as const, container: segments[0]! };
    return containerUri(location.container) === value ? location : undefined;
  }
  if (segments.length === 2) {
    const location = {
      kind: "module" as const,
      container: segments[0]!,
      module: segments[1]!,
    };
    return moduleUri(location.container, location.module) === value ? location : undefined;
  }
  if (segments.length === 4 && segments[2] === "files") {
    const location = {
      kind: "file" as const,
      container: segments[0]!,
      module: segments[1]!,
      path: segments[3]!,
    };
    return moduleFileUri(location.container, location.module, location.path) === value
      ? location
      : undefined;
  }
  return undefined;
}

export function fileTreeUri(prefix: string, path: string): string {
  return `${prefix}/${path.split("/").map(encodeUriSegment).join("/")}`;
}

/** SDK v1 template matching returns the percent-encoded capture, so decode exactly once. */
export function decodeTemplateValue(
  value: string | string[] | undefined,
  uri: URL,
): string {
  if (typeof value !== "string") {
    throw new McpError(-32002, `Resource not found: ${uri.toString()}`);
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new McpError(-32002, `Resource not found: ${uri.toString()}`);
  }
}
