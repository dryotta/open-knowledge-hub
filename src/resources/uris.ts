import { McpError } from "@modelcontextprotocol/sdk/types.js";

export const CONTAINERS_URI = "okh://containers";
export const DOCS_URI_PREFIX = "okh://docs";
export const INSTRUCTIONS_URI_PREFIX = "okh://instructions";

export const CONTAINER_URI_TEMPLATE = `${CONTAINERS_URI}/{container}`;
export const MODULE_URI_TEMPLATE = `${CONTAINERS_URI}/{container}/modules/{module}`;
export const MODULE_FILE_URI_TEMPLATE =
  `${CONTAINERS_URI}/{container}/modules/{module}/files/{path}`;

export function encodeUriSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function containerUri(container: string): string {
  return `${CONTAINERS_URI}/${encodeUriSegment(container)}`;
}

export function moduleUri(container: string, module: string): string {
  return `${containerUri(container)}/modules/${encodeUriSegment(module)}`;
}

export function moduleFileUri(container: string, module: string, path: string): string {
  return `${moduleUri(container, module)}/files/${encodeUriSegment(path)}`;
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
