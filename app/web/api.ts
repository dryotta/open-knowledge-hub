import type { TodoListResult, TodoMutationInput, TodoMutationResult } from "../../src/todos/types.js";
import type {
  WorkspaceCreateInput,
  WorkspaceGetResult,
  WorkspaceInterveneInput,
  WorkspaceMutationResult,
  WorkspaceUpdateInput,
} from "../../src/workspaces/types.js";
import type {
  WebAgentsResponse,
  WebAttentionResponse,
  WebContainersResponse,
  WebDirectoryResponse,
  WebErrorResponse,
  WebFileResponse,
  WebProjectDetailResponse,
  WebWorkspaceDetailResponse,
  WebWorkspacesResponse,
} from "../../src/web/types.js";
import { projectApiPath, workspaceApiPath } from "./routing.js";

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

export type WorkspaceWebMutation =
  | Omit<WorkspaceCreateInput, "container" | "module">
  | Omit<WorkspaceUpdateInput, "container" | "module" | "project">
  | Omit<WorkspaceInterveneInput, "container" | "module" | "project">
  | {
      operation: "configure";
      set: {
        description?: string;
        lead?: string;
        agents?: string[];
      };
    };

export type WorkspaceWebMutationResult =
  | WorkspaceMutationResult
  | WorkspaceGetResult;

export function getWorkspaces(signal?: AbortSignal): Promise<WebWorkspacesResponse> {
  return request("/api/workspaces", { signal });
}

export function getWorkspace(
  container: string,
  module: string,
  signal?: AbortSignal,
): Promise<WebWorkspaceDetailResponse> {
  return request(workspaceApiPath(container, module), { signal });
}

export function getProject(
  container: string,
  module: string,
  project: string,
  signal?: AbortSignal,
): Promise<WebProjectDetailResponse> {
  return request(projectApiPath(container, module, project), { signal });
}

export function getAttention(signal?: AbortSignal): Promise<WebAttentionResponse> {
  return request("/api/workspaces/attention", { signal });
}

export function getAgents(signal?: AbortSignal): Promise<WebAgentsResponse> {
  return request("/api/agents", { signal });
}

export function mutateWorkspace(
  container: string,
  module: string,
  input: WorkspaceWebMutation,
  project?: string,
  signal?: AbortSignal,
): Promise<WorkspaceWebMutationResult> {
  return request(
    project
      ? projectApiPath(container, module, project)
      : workspaceApiPath(container, module),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    },
  );
}
