export type AppRoute =
  | { id: "home"; params: Record<string, never> }
  | { id: "browse"; params: Record<string, never> }
  | { id: "todos"; params: Record<string, never> }
  | { id: "workspaces"; params: Record<string, never> }
  | { id: "attention"; params: Record<string, never> }
  | { id: "workspace"; params: { container: string; module: string } }
  | {
      id: "project";
      params: { container: string; module: string; project: string };
    }
  | { id: "agents"; params: Record<string, never> }
  | { id: "not-found"; params: Record<string, never> };

function decodeSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded
      && decoded !== "."
      && decoded !== ".."
      && !/[\/\\\0-\x1f\x7f]/u.test(decoded)
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

function decodeModule(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    const parts = decoded.split("/");
    return decoded
      && !decoded.includes("\\")
      && parts.every((part) =>
        part && part !== "." && part !== ".." && !/[\0-\x1f\x7f]/u.test(part))
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

export function matchRoute(pathname: string): AppRoute {
  if (pathname === "/") return { id: "home", params: {} };
  if (pathname === "/browse") return { id: "browse", params: {} };
  if (pathname === "/todos") return { id: "todos", params: {} };
  if (pathname === "/workspaces") return { id: "workspaces", params: {} };
  if (pathname === "/workspaces/attention") return { id: "attention", params: {} };
  if (pathname === "/agents") return { id: "agents", params: {} };
  if (!pathname.startsWith("/workspaces/")) return { id: "not-found", params: {} };

  const segments = pathname.slice(1).split("/");
  const container = segments[1] ? decodeSegment(segments[1]) : undefined;
  const module = segments[2] ? decodeModule(segments[2]) : undefined;
  if (!container || !module) return { id: "not-found", params: {} };
  if (segments.length === 3) {
    return { id: "workspace", params: { container, module } };
  }
  if (segments.length === 5 && segments[3] === "projects") {
    const project = segments[4] ? decodeSegment(segments[4]) : undefined;
    if (project && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(project)) {
      return { id: "project", params: { container, module, project } };
    }
  }
  return { id: "not-found", params: {} };
}

export function workspacePath(container: string, module: string): string {
  return `/workspaces/${encodeURIComponent(container)}/${encodeURIComponent(module)}`;
}

export function projectPath(container: string, module: string, project: string): string {
  return `${workspacePath(container, module)}/projects/${encodeURIComponent(project)}`;
}

export function workspaceApiPath(container: string, module: string): string {
  return `/api/workspaces/${encodeURIComponent(container)}/${encodeURIComponent(module)}`;
}

export function projectApiPath(container: string, module: string, project: string): string {
  return `${workspaceApiPath(container, module)}/projects/${encodeURIComponent(project)}`;
}
