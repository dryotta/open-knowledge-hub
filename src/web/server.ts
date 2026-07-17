import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ContainerService, ResolvedModule } from "../container/service.js";
import { isOkhError } from "../errors.js";
import { isPathWithin, normalizeModuleRelativePath } from "../modules/pathSafety.js";
import type { TodoService } from "../todos/service.js";
import type { TodoMutationInput, TodoQuery } from "../todos/types.js";
import type {
  WebContainerSummary,
  WebContainersResponse,
  WebDirectoryResponse,
  WebErrorResponse,
  WebFileEntry,
  WebFileResponse,
} from "./types.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const WEB_ASSET_ROOT = new URL("../../dist/web-app/", import.meta.url);

const todoPrioritySchema = z.enum(["lowest", "low", "normal", "medium", "high", "highest"]);
const todoQuerySchema = z.object({
  container: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
  status: z.enum(["open", "completed", "custom", "all"]).optional(),
  labels: z.array(z.string()).optional(),
  labelMode: z.enum(["any", "all"]).optional(),
  priorities: z.array(todoPrioritySchema).optional(),
  dueAfter: z.string().optional(),
  dueBefore: z.string().optional(),
  overdue: z.boolean().optional(),
  query: z.string().optional(),
}).strict();
const createTodoSchema = z.object({
  operation: z.literal("create"),
  container: z.string().min(1),
  module: z.string().min(1),
  text: z.string(),
  entrySummary: z.string().optional(),
  observation: z.string().optional(),
  labels: z.array(z.string()).optional(),
  due: z.string().optional(),
  priority: todoPrioritySchema.optional(),
}).strict();
const updateTodoSchema = z.object({
  operation: z.literal("update"),
  ref: z.string().min(1),
  completed: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
  due: z.string().nullable().optional(),
  priority: todoPrioritySchema.nullable().optional(),
}).strict();
const todoMutationSchema = z.discriminatedUnion("operation", [createTodoSchema, updateTodoSchema]);

interface WebAssets {
  index: Buffer;
  javascript: Buffer;
  styles: Buffer;
}

export interface StartWebServerOptions {
  service: ContainerService;
  todos: TodoService;
  port?: number;
  env?: NodeJS.ProcessEnv;
}

export interface WebServerHandle {
  origin: string;
  browseUrl: string;
  todosUrl: string;
  close: () => Promise<void>;
}

export type WebServerWarningLogger = (message: string) => void;

class WebHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WebHttpError";
  }
}

function parseWebPort(env: NodeJS.ProcessEnv): number {
  const raw = env.OKH_WEB_PORT?.trim();
  if (!raw) return 0;
  if (!/^\d+$/u.test(raw)) {
    throw new Error("OKH_WEB_PORT must be an integer from 0 through 65535.");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("OKH_WEB_PORT must be an integer from 0 through 65535.");
  }
  return port;
}

async function loadWebAssets(): Promise<WebAssets> {
  const [index, javascript, styles] = await Promise.all([
    readFile(new URL("index.html", WEB_ASSET_ROOT)),
    readFile(new URL("assets/app.js", WEB_ASSET_ROOT)),
    readFile(new URL("assets/styles.css", WEB_ASSET_ROOT)),
  ]);
  return { index, javascript, styles };
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendBuffer(
  response: ServerResponse,
  status: number,
  contentType: string,
  content: Buffer,
  cacheControl = "no-cache",
): void {
  applySecurityHeaders(response);
  response.statusCode = status;
  response.setHeader("Cache-Control", cacheControl);
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", content.byteLength);
  response.setHeader("Connection", "close");
  response.end(content);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  sendBuffer(
    response,
    status,
    "application/json; charset=utf-8",
    Buffer.from(`${JSON.stringify(value)}\n`, "utf8"),
    "no-store",
  );
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof WebHttpError) {
    sendJson(response, error.status, {
      error: { code: error.code, message: error.message },
    } satisfies WebErrorResponse);
    return;
  }
  if (isOkhError(error)) {
    const status = error.code === "NOT_FOUND"
      ? 404
      : error.code === "CONFLICT" || error.code === "ALREADY_EXISTS"
        ? 409
        : 400;
    sendJson(response, status, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.hint ? { hint: error.hint } : {}),
      },
    } satisfies WebErrorResponse);
    return;
  }

  process.stderr.write(`Web UI request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  sendJson(response, 500, {
    error: { code: "INTERNAL_ERROR", message: "The web UI request failed." },
  } satisfies WebErrorResponse);
}

function requireQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim();
  if (!value) throw new WebHttpError(400, "INVALID_ARGUMENT", `${name} is required.`);
  return value;
}

function normalizeRelativePath(value: string, allowEmpty: boolean): string {
  const normalized = normalizeModuleRelativePath(value, allowEmpty);
  if (normalized === undefined) {
    throw new WebHttpError(400, "INVALID_PATH", "The requested path must be a safe module-relative path.");
  }
  return normalized;
}

async function resolveModule(service: ContainerService, container: string, module: string): Promise<ResolvedModule> {
  const targets = await service.resolveTargets(container, module);
  const resolved = targets[0]?.modules[0];
  if (!resolved) {
    throw new WebHttpError(404, "NOT_FOUND", `Container "${container}" has no module "${module}".`);
  }
  return resolved;
}

async function resolveModulePath(
  module: ResolvedModule,
  requestedPath: string,
  allowRoot: boolean,
): Promise<{ normalized: string; realPath: string }> {
  const normalized = normalizeRelativePath(requestedPath, allowRoot);
  const moduleRoot = await realpath(module.absPath);
  const candidate = normalized
    ? resolve(module.absPath, ...normalized.split("/"))
    : module.absPath;
  let candidateReal: string;
  try {
    candidateReal = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WebHttpError(404, "NOT_FOUND", `No file or directory exists at "${normalized}".`);
    }
    throw error;
  }
  if (!isPathWithin(moduleRoot, candidateReal)) {
    throw new WebHttpError(400, "INVALID_PATH", "The requested path escapes the module.");
  }
  return { normalized, realPath: candidateReal };
}

async function listDirectory(
  service: ContainerService,
  container: string,
  modulePath: string,
  requestedPath: string,
): Promise<WebDirectoryResponse> {
  const module = await resolveModule(service, container, modulePath);
  const { normalized, realPath } = await resolveModulePath(module, requestedPath, true);
  const info = await stat(realPath);
  if (!info.isDirectory()) {
    throw new WebHttpError(400, "NOT_A_DIRECTORY", `"${normalized}" is not a directory.`);
  }

  const dirents = await readdir(realPath, { withFileTypes: true });
  const entries = (await Promise.all(dirents.map(async (entry): Promise<WebFileEntry | undefined> => {
    if (entry.isSymbolicLink() || entry.name === ".git") return undefined;
    const path = normalized ? `${normalized}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return { name: entry.name, path, kind: "directory" };
    if (!entry.isFile()) return undefined;
    const fileInfo = await stat(resolve(realPath, entry.name));
    return { name: entry.name, path, kind: "file", size: fileInfo.size };
  })))
    .filter((entry): entry is WebFileEntry => entry !== undefined)
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  return { container, module: modulePath, path: normalized, entries };
}

async function loadTextFile(
  service: ContainerService,
  container: string,
  modulePath: string,
  requestedPath: string,
): Promise<WebFileResponse> {
  const module = await resolveModule(service, container, modulePath);
  const { normalized, realPath } = await resolveModulePath(module, requestedPath, false);
  const info = await stat(realPath);
  if (!info.isFile()) {
    throw new WebHttpError(400, "NOT_A_FILE", `"${normalized}" is not a file.`);
  }
  if (info.size > MAX_TEXT_FILE_BYTES) {
    throw new WebHttpError(413, "FILE_TOO_LARGE", `Files larger than ${MAX_TEXT_FILE_BYTES} bytes cannot be previewed.`);
  }

  const content = await readFile(realPath);
  if (content.subarray(0, Math.min(content.length, 8192)).includes(0)) {
    throw new WebHttpError(415, "BINARY_FILE", "Binary files cannot be previewed.");
  }
  return {
    container,
    module: modulePath,
    path: normalized,
    content: content.toString("utf8"),
    size: info.size,
  };
}

function parseBoolean(value: string | null, name: string): boolean | undefined {
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new WebHttpError(400, "INVALID_ARGUMENT", `${name} must be true or false.`);
}

function parseTodoQuery(url: URL): TodoQuery {
  const labels = url.searchParams.getAll("label");
  const priorities = url.searchParams.getAll("priority");
  const candidate = {
    container: url.searchParams.get("container") ?? undefined,
    module: url.searchParams.get("module") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    labels: labels.length > 0 ? labels : undefined,
    labelMode: url.searchParams.get("labelMode") ?? undefined,
    priorities: priorities.length > 0 ? priorities : undefined,
    dueAfter: url.searchParams.get("dueAfter") ?? undefined,
    dueBefore: url.searchParams.get("dueBefore") ?? undefined,
    overdue: parseBoolean(url.searchParams.get("overdue"), "overdue"),
    query: url.searchParams.get("query") ?? undefined,
  };
  const parsed = todoQuerySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new WebHttpError(400, "INVALID_ARGUMENT", parsed.error.issues[0]?.message ?? "Invalid todo query.");
  }
  return parsed.data;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new WebHttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Requests must use application/json.");
  }

  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new WebHttpError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new WebHttpError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WebHttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

function assertSameOrigin(request: IncomingMessage, origin: string): void {
  if (request.headers.origin !== origin) {
    throw new WebHttpError(403, "FORBIDDEN", "Todo changes require a same-origin web UI request.");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin") {
    throw new WebHttpError(403, "FORBIDDEN", "Cross-site todo changes are not allowed.");
  }
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string,
  service: ContainerService,
  todos: TodoService,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/")) return false;

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { status: "ok", origin });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/containers") {
    const result = await service.inspect();
    if (result.kind !== "hub") {
      throw new Error("Container inspection returned an unexpected result.");
    }
    const containers: WebContainerSummary[] = result.containers.map((c) => ({
      name: c.name,
      backend: c.backend,
      ...(c.sync ? { sync: c.sync } : {}),
      ...(c.syncActions ? { syncActions: c.syncActions } : {}),
      moduleCount: c.modules.length,
      modules: c.modules.map((m) => ({ path: m.path, type: m.type })),
      manifestValid: c.manifestValid,
      localPath: c.localPath,
    }));
    sendJson(response, 200, { containers } satisfies WebContainersResponse);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/files") {
    const result = await listDirectory(
      service,
      requireQuery(url, "container"),
      requireQuery(url, "module"),
      url.searchParams.get("path") ?? "",
    );
    sendJson(response, 200, result);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/file") {
    const result = await loadTextFile(
      service,
      requireQuery(url, "container"),
      requireQuery(url, "module"),
      requireQuery(url, "path"),
    );
    sendJson(response, 200, result);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/todos") {
    sendJson(response, 200, await todos.list(parseTodoQuery(url)));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/todos") {
    assertSameOrigin(request, origin);
    const parsed = todoMutationSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new WebHttpError(400, "INVALID_ARGUMENT", parsed.error.issues[0]?.message ?? "Invalid todo mutation.");
    }
    const input = { ...parsed.data, apply: true } as TodoMutationInput;
    sendJson(response, 200, await todos.mutate(input));
    return true;
  }

  if (["GET", "POST"].includes(request.method ?? "")) {
    throw new WebHttpError(404, "NOT_FOUND", "The requested API endpoint does not exist.");
  }
  throw new WebHttpError(405, "METHOD_NOT_ALLOWED", "The requested HTTP method is not supported.");
}

function serveApp(response: ServerResponse, assets: WebAssets, pathname: string): boolean {
  if (pathname === "/assets/app.js") {
    sendBuffer(response, 200, "text/javascript; charset=utf-8", assets.javascript);
    return true;
  }
  if (pathname === "/assets/styles.css") {
    sendBuffer(response, 200, "text/css; charset=utf-8", assets.styles);
    return true;
  }
  if (pathname.startsWith("/assets/")) return false;
  sendBuffer(response, 200, "text/html; charset=utf-8", assets.index);
  return true;
}

export async function startWebServer(options: StartWebServerOptions): Promise<WebServerHandle> {
  const assets = await loadWebAssets();
  const requestedPort = options.port ?? parseWebPort(options.env ?? process.env);
  let origin = "";

  const server = createServer((request, response) => {
    void (async () => {
      if (!origin) throw new Error("Web UI server origin is not initialized.");
      if (request.headers.host !== new URL(origin).host) {
        throw new WebHttpError(421, "MISDIRECTED_REQUEST", "The request host is not allowed.");
      }

      const url = new URL(request.url ?? "/", origin);
      if (await handleApiRequest(request, response, url, origin, options.service, options.todos)) return;
      if (request.method !== "GET") {
        throw new WebHttpError(405, "METHOD_NOT_ALLOWED", "The requested HTTP method is not supported.");
      }
      if (!serveApp(response, assets, url.pathname)) {
        sendBuffer(response, 404, "text/plain; charset=utf-8", Buffer.from("Not found.\n", "utf8"), "no-store");
      }
    })().catch((error: unknown) => sendError(response, error));
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen(requestedPort, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error("Web UI server did not report a listening address.");
  }
  origin = `http://${LOOPBACK_HOST}:${address.port}`;
  server.keepAliveTimeout = 1000;
  server.unref();

  return {
    origin,
    browseUrl: `${origin}/browse`,
    todosUrl: `${origin}/todos`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    }),
  };
}

export async function tryStartWebServer(
  options: StartWebServerOptions,
  warn: WebServerWarningLogger = (message) => process.stderr.write(`${message}\n`),
): Promise<WebServerHandle | undefined> {
  const env = options.env ?? process.env;
  const configuredPort = options.port ?? env.OKH_WEB_PORT?.trim();
  const hasFixedPort = configuredPort !== undefined && configuredPort !== "" && configuredPort !== 0 && configuredPort !== "0";

  try {
    return await startWebServer(options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!hasFixedPort) {
      warn(`open-knowledge-hub web UI unavailable: ${detail}`);
      return undefined;
    }

    warn(`open-knowledge-hub web UI could not use the configured port: ${detail}; retrying with a dynamic port.`);
    try {
      return await startWebServer({ ...options, port: 0 });
    } catch (fallbackError) {
      const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      warn(`open-knowledge-hub web UI unavailable: ${fallbackDetail}`);
      return undefined;
    }
  }
}
