import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import type { Gh } from "../src/git/gh.js";
import { TodoService } from "../src/todos/service.js";
import { startWebServer, tryStartWebServer, type WebServerHandle } from "../src/web/server.js";
import type { TodoListResult, TodoMutationResult } from "../src/todos/types.js";
import type {
  WebContainersResponse,
  WebDirectoryResponse,
  WebFileResponse,
} from "../src/web/types.js";
import { makePaths, makeTempDir, testRun } from "./helpers.js";

class FakeGh {
  async createRepo(): Promise<string> {
    return "x";
  }

  async createPr(): Promise<string> {
    return "x";
  }
}

const cleanups: string[] = [];
const webServers: WebServerHandle[] = [];

afterEach(async () => {
  await Promise.all(webServers.splice(0).map((server) => server.close()));
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createFixture(): Promise<{
  service: ContainerService;
  todos: TodoService;
  containerRoot: string;
}> {
  const home = await makeTempDir();
  cleanups.push(home);
  const containerRoot = join(home, "workspace");
  await mkdir(containerRoot, { recursive: true });
  const service = new ContainerService(makePaths(home), new Git(testRun), new FakeGh() as unknown as Gh);
  await service.addContainer({ source: containerRoot, name: "hub", create: true });
  await service.addModule({ container: "hub", path: "docs", type: "docs", description: "team docs", create: true });
  await service.addModule({ container: "hub", path: "memory", type: "memory", description: "team memory", create: true });
  await mkdir(join(containerRoot, "docs", "nested"), { recursive: true });
  await writeFile(join(containerRoot, "docs", "README.md"), "# Documentation\n", "utf8");
  await writeFile(join(containerRoot, "docs", "nested", "notes.txt"), "Nested notes\n", "utf8");
  await writeFile(join(containerRoot, "memory", "tasks.md"), "- [ ] Test the hosted UI #todo #web\n", "utf8");

  const todos = new TodoService(service, () => new Date("2026-07-11T12:00:00.000Z"));
  return { service, todos, containerRoot };
}

async function setup(): Promise<{
  web: WebServerHandle;
  containerRoot: string;
}> {
  const { service, todos, containerRoot } = await createFixture();
  const web = await startWebServer({ service, todos, port: 0 });
  webServers.push(web);
  return { web, containerRoot };
}

async function requestWithHost(url: string, host: string): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: "GET",
      headers: { Host: host },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolveRequest({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", rejectRequest);
    request.end();
  });
}

describe("hosted web UI", () => {
  it("serves the feature shell and health endpoint from the MCP process", async () => {
    const { web } = await setup();

    const page = await fetch(web.browseUrl);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain('data-app="open-knowledge-hub-web"');

    const script = await fetch(`${web.origin}/assets/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");

    const health = await fetch(`${web.origin}/api/health`);
    expect(await health.json()).toEqual({ status: "ok", origin: web.origin });

    const futureRoute = await fetch(`${web.origin}/future-feature`);
    expect(futureRoute.status).toBe(200);
    expect(await futureRoute.text()).toContain('data-app="open-knowledge-hub-web"');

    const rebound = await requestWithHost(`${web.origin}/api/health`, "attacker.example");
    expect(rebound.status).toBe(421);
    expect(JSON.parse(rebound.body)).toMatchObject({
      error: { code: "MISDIRECTED_REQUEST" },
    });
  });

  it("falls back to a dynamic port when the configured port is busy", async () => {
    const blocker = createHttpServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      blocker.once("error", rejectListen);
      blocker.listen(0, "127.0.0.1", () => resolveListen());
    });
    const blockedPort = (blocker.address() as AddressInfo).port;
    const warnings: string[] = [];

    try {
      const { service, todos } = await createFixture();
      const web = await tryStartWebServer(
        {
          service,
          todos,
          env: { ...process.env, OKH_WEB_PORT: String(blockedPort) },
        },
        (message) => warnings.push(message),
      );

      expect(web).toBeDefined();
      expect(new URL(web!.origin).port).not.toBe(String(blockedPort));
      expect(warnings).toEqual([
        expect.stringContaining("retrying with a dynamic port"),
      ]);
      webServers.push(web!);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        blocker.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
  });

  it("lists containers, browses module directories, and previews text files", async () => {
    const { web } = await setup();

    const containers = await fetch(`${web.origin}/api/containers`);
    const containerBody = await containers.json() as WebContainersResponse;
    expect(containerBody.containers).toEqual([
      expect.objectContaining({
        name: "hub",
        backend: "local",
        sync: { mode: "auto", config: {} },
        syncActions: [],
        modules: expect.arrayContaining([
          expect.objectContaining({ path: "docs", type: "docs" }),
          expect.objectContaining({ path: "memory", type: "memory" }),
        ]),
      }),
    ]);

    const files = await fetch(`${web.origin}/api/files?container=hub&module=docs&path=`);
    const directory = await files.json() as WebDirectoryResponse;
    expect(directory.entries).toEqual([
      { name: ".okh", path: ".okh", kind: "directory" },
      { name: "nested", path: "nested", kind: "directory" },
      { name: "README.md", path: "README.md", kind: "file", size: 16 },
    ]);

    const file = await fetch(`${web.origin}/api/file?container=hub&module=docs&path=README.md`);
    expect(await file.json() as WebFileResponse).toMatchObject({
      container: "hub",
      module: "docs",
      path: "README.md",
      content: "# Documentation\n",
      size: 16,
    });

    const traversal = await fetch(`${web.origin}/api/file?container=hub&module=docs&path=..%2Ftasks.md`);
    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toMatchObject({
      error: { code: "INVALID_PATH" },
    });
  });

  it("lists and mutates todos while rejecting cross-origin writes", async () => {
    const { web, containerRoot } = await setup();

    const listed = await fetch(`${web.origin}/api/todos`);
    const todoList = await listed.json() as TodoListResult;
    expect(todoList.tasks).toHaveLength(1);
    const ref = todoList.tasks[0]!.ref;

    const blocked = await fetch(`${web.origin}/api/todos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "update", ref, completed: true }),
    });
    expect(blocked.status).toBe(403);

    const updated = await fetch(`${web.origin}/api/todos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: web.origin,
      },
      body: JSON.stringify({ operation: "update", ref, completed: true }),
    });
    const updateResult = await updated.json() as TodoMutationResult;
    expect(updateResult).toMatchObject({
      operation: "update",
      applied: true,
      dirtyContainer: "hub",
      todo: { status: "completed", text: "Test the hosted UI" },
    });
    expect(await readFile(join(containerRoot, "memory", "tasks.md"), "utf8")).toContain("- [x] Test the hosted UI");

    const created = await fetch(`${web.origin}/api/todos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: web.origin,
      },
      body: JSON.stringify({
        operation: "create",
        container: "hub",
        module: "memory",
        text: "Create from web",
        labels: ["web"],
      }),
    });
    expect(await created.json()).toMatchObject({
      operation: "create",
      applied: true,
      dirtyContainer: "hub",
      todo: { text: "Create from web", labels: ["web"] },
    });
  });
});
