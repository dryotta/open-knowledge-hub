import type { TodoListResult, TodoMutationInput, TodoMutationResult } from "../../src/todos/types.js";
import type {
  WebContainersResponse,
  WebDirectoryResponse,
  WebErrorResponse,
  WebFileResponse,
} from "../../src/web/types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  });
  const payload = await response.json() as T | WebErrorResponse;
  if (!response.ok) {
    const error = (payload as WebErrorResponse).error;
    throw new ApiError(response.status, error.code, error.message, error.hint);
  }
  return payload as T;
}

function queryPath(path: string, values: Record<string, string>): string {
  const query = new URLSearchParams(values);
  return `${path}?${query.toString()}`;
}

export function getContainers(signal?: AbortSignal): Promise<WebContainersResponse> {
  return request("/api/containers", { signal });
}

export function getDirectory(
  container: string,
  module: string,
  path: string,
  signal?: AbortSignal,
): Promise<WebDirectoryResponse> {
  return request(queryPath("/api/files", { container, module, path }), { signal });
}

export function getFile(
  container: string,
  module: string,
  path: string,
  signal?: AbortSignal,
): Promise<WebFileResponse> {
  return request(queryPath("/api/file", { container, module, path }), { signal });
}

export function getTodos(signal?: AbortSignal): Promise<TodoListResult> {
  return request("/api/todos", { signal });
}

export function mutateTodo(
  input: TodoMutationInput,
  signal?: AbortSignal,
): Promise<TodoMutationResult> {
  const body: Record<string, unknown> = { ...input };
  delete body.apply;
  return request("/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}
