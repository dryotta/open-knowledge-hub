import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import type { Gh } from "../src/git/gh.js";
import { TodoService } from "../src/todos/service.js";
import { workspaceLoader } from "../src/modules/loaders/workspace.js";
import { WorkspaceService } from "../src/workspaces/service.js";
import { startWebServer, tryStartWebServer, type WebServerHandle } from "../src/web/server.js";
import type { TodoListResult, TodoMutationResult } from "../src/todos/types.js";
import type { WorkspaceMutationResult } from "../src/workspaces/types.js";
import type {
  WebAgentsResponse,
  WebAttentionResponse,
  WebContainersResponse,
  WebDirectoryResponse,
  WebFileResponse,
  WebProjectDetailResponse,
  WebWorkspaceDetailResponse,
  WebWorkspacesResponse,
} from "../src/web/types.js";
import { makePaths, makeTempDir, testRun, writeModule } from "./helpers.js";

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
  workspaces: WorkspaceService;
  containerRoot: string;
}> {
  const home = await makeTempDir();
  cleanups.push(home);
  const containerRoot = join(home, "workspace");
  await mkdir(containerRoot, { recursive: true });
  const paths = makePaths(home);
  const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
  await service.addContainer({ source: containerRoot, name: "hub", create: true });
  await service.addModule({ container: "hub", path: "docs", type: "docs", description: "team docs", create: true });
  await service.addModule({ container: "hub", path: "memory", type: "memory", description: "team memory", create: true });
  await mkdir(join(containerRoot, "docs", "nested"), { recursive: true });
  await writeFile(join(containerRoot, "docs", "README.md"), "# Documentation\n", "utf8");
  await writeFile(join(containerRoot, "docs", "nested", "notes.txt"), "Nested notes\n", "utf8");
  await writeFile(join(containerRoot, "memory", "tasks.md"), "- [ ] Test the hosted UI #todo #web\n", "utf8");
  await writeModule(containerRoot, "agents", {
    type: "agents",
    description: "Workspace agents",
  });
  await mkdir(join(containerRoot, "agents", ".github", "agents"), { recursive: true });
  await writeFile(
    join(containerRoot, "agents", ".github", "agents", "lead.agent.md"),
    "---\ndescription: Coordinates projects\n---\n\nLead the work.\n",
    "utf8",
  );
  await writeModule(containerRoot, "investigations", {
    type: "workspace",
    description: "Investigate evidence-based questions.",
    config: { lead: "agents/lead", agents: [] },
  });
  await workspaceLoader.scaffold!(join(containerRoot, "investigations"));

  const todos = new TodoService(service, () => new Date("2026-07-11T12:00:00.000Z"));
  let tick = Date.parse("2026-07-11T12:00:00.000Z");
  const workspaces = new WorkspaceService(service, paths, () => {
    tick += 1_000;
    return new Date(tick);
  });
  await workspaces.create({
    operation: "create",
    container: "hub",
    module: "investigations",
    guidance: "Prefer primary evidence.",
    acceptance: ["Cite material claims."],
    commandId: "00000000-0000-4000-8000-000000000001",
  });
  await workspaces.create({
    operation: "create",
    container: "hub",
    module: "investigations",
    project: "supplier-risk",
    title: "Supplier risk",
    goal: "Recommend resilient alternatives.",
    tags: ["sourcing"],
    commandId: "00000000-0000-4000-8000-000000000002",
  });
  return { service, todos, workspaces, containerRoot };
}

async function setup(): Promise<{
  web: WebServerHandle;
  containerRoot: string;
  workspaces: WorkspaceService;
}> {
  const { service, todos, workspaces, containerRoot } = await createFixture();
  const web = await startWebServer({ service, todos, workspaces, port: 0 });
  webServers.push(web);
  return { web, containerRoot, workspaces };
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
      const { service, todos, workspaces } = await createFixture();
      const web = await tryStartWebServer(
        {
          service,
          todos,
          workspaces,
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

  it("serves workspace, project, attention, and agent views", async () => {
    const { web, workspaces } = await setup();
    const initial = await workspaces.get({
      operation: "get",
      container: "hub",
      module: "investigations",
      project: "supplier-risk",
    });
    const started = await workspaces.start({
      operation: "start",
      container: "hub",
      module: "investigations",
      project: "supplier-risk",
      etag: initial.etag,
      commandId: "00000000-0000-4000-8000-000000000003",
    });
    await workspaces.report({
      operation: "report",
      container: "hub",
      module: "investigations",
      project: "supplier-risk",
      run: started.resume!.runId,
      state: "paused",
      checkpoint: {
        summary: "Evidence needs human confirmation.",
        question: "Should regional sources be required?",
      },
      etag: started.etag,
      commandId: "00000000-0000-4000-8000-000000000004",
    });

    const listResponse = await fetch(web.workspacesUrl);
    expect(await listResponse.text()).toContain('data-app="open-knowledge-hub-web"');

    const workspacesResponse = await fetch(`${web.origin}/api/workspaces`);
    expect(await workspacesResponse.json() as WebWorkspacesResponse).toMatchObject({
      workspaces: [{
        container: "hub",
        module: "investigations",
        counts: { active: 1, attention: 1 },
        agentHealth: "valid",
      }],
    });

    const workspaceResponse = await fetch(`${web.origin}/api/workspaces/hub/investigations`);
    expect(await workspaceResponse.json() as WebWorkspaceDetailResponse).toMatchObject({
      detail: {
        workspace: { lead: "agents/lead" },
        counts: { activeRuns: 1, attention: 1 },
      },
      projects: [{ id: "supplier-risk", attention: { kind: "paused" } }],
    });

    const projectResponse = await fetch(
      `${web.origin}/api/workspaces/hub/investigations/projects/supplier-risk`,
    );
    expect(await projectResponse.json() as WebProjectDetailResponse).toMatchObject({
      detail: {
        project: { id: "supplier-risk" },
        resume: {
          checkpoint: { question: "Should regional sources be required?" },
        },
      },
      activity: expect.arrayContaining([
        expect.objectContaining({ type: "run.paused" }),
      ]),
    });

    const attentionResponse = await fetch(`${web.origin}/api/workspaces/attention`);
    expect(await attentionResponse.json() as WebAttentionResponse).toMatchObject({
      entries: [{
        container: "hub",
        module: "investigations",
        project: { id: "supplier-risk" },
      }],
    });

    const agentsResponse = await fetch(web.agentsUrl.replace("/agents", "/api/agents"));
    expect(await agentsResponse.json() as WebAgentsResponse).toMatchObject({
      agents: [{
        id: "lead",
        referencedBy: [{
          container: "hub",
          module: "investigations",
          role: "lead",
        }],
      }],
      issues: [],
    });

    const unsafeRoute = await fetch(`${web.origin}/api/workspaces/hub/docs%2F..`);
    expect(unsafeRoute.status).toBe(400);
    expect(await unsafeRoute.json()).toMatchObject({
      error: { code: "INVALID_PATH" },
    });
  });

  it("applies same-origin workspace review and lifecycle changes", async () => {
    const { web, workspaces } = await setup();
    const projectUrl = `${web.origin}/api/workspaces/hub/investigations/projects/supplier-risk`;
    const initial = await workspaces.get({
      operation: "get",
      container: "hub",
      module: "investigations",
      project: "supplier-risk",
    });
    const started = await workspaces.start({
      operation: "start",
      container: "hub",
      module: "investigations",
      project: "supplier-risk",
      etag: initial.etag,
      commandId: "00000000-0000-4000-8000-000000000010",
    });
    const paused = await workspaces.report({
      operation: "report",
      container: "hub",
      module: "investigations",
      project: "supplier-risk",
      run: started.resume!.runId,
      state: "paused",
      checkpoint: { summary: "Review source selection.", question: "Use regulator data?" },
      etag: started.etag,
      commandId: "00000000-0000-4000-8000-000000000011",
    });

    const blocked = await fetch(projectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "intervene",
        run: started.resume!.runId,
        action: "guide",
        guidance: "Use regulator data.",
        etag: paused.etag,
        commandId: "00000000-0000-4000-8000-000000000012",
      }),
    });
    expect(blocked.status).toBe(403);

    const guidedResponse = await fetch(projectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: web.origin },
      body: JSON.stringify({
        operation: "intervene",
        run: started.resume!.runId,
        action: "guide",
        guidance: "Use regulator data.",
        etag: paused.etag,
        commandId: "00000000-0000-4000-8000-000000000012",
      }),
    });
    expect(guidedResponse.status).toBe(200);
    const guided = await guidedResponse.json() as WorkspaceMutationResult;
    const guidedDetail = await workspaces.get({
      operation: "get",
      container: "hub",
      module: "investigations",
      project: "supplier-risk",
      include: ["resume"],
    });
    expect(guidedDetail.resume?.guidance).toEqual([
      expect.objectContaining({ text: "Use regulator data." }),
    ]);

    const cancelledResponse = await fetch(projectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: web.origin },
      body: JSON.stringify({
        operation: "intervene",
        run: started.resume!.runId,
        action: "cancel",
        reason: "No longer required.",
        etag: guided.etag,
        commandId: "00000000-0000-4000-8000-000000000013",
      }),
    });
    const cancelled = await cancelledResponse.json() as WorkspaceMutationResult;
    expect(cancelled.project).toMatchObject({ activeRun: null });

    const archivedResponse = await fetch(projectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: web.origin },
      body: JSON.stringify({
        operation: "update",
        action: "archive",
        etag: cancelled.etag,
        commandId: "00000000-0000-4000-8000-000000000014",
      }),
    });
    const archived = await archivedResponse.json() as WorkspaceMutationResult;
    expect(archived.project).toMatchObject({ status: "archived" });

    const staleResponse = await fetch(projectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: web.origin },
      body: JSON.stringify({
        operation: "update",
        action: "unarchive",
        etag: cancelled.etag,
        commandId: "00000000-0000-4000-8000-000000000015",
      }),
    });
    expect(staleResponse.status).toBe(409);

    const unarchivedResponse = await fetch(projectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: web.origin },
      body: JSON.stringify({
        operation: "update",
        action: "unarchive",
        etag: archived.etag,
        commandId: "00000000-0000-4000-8000-000000000016",
      }),
    });
    expect(await unarchivedResponse.json()).toMatchObject({
      project: { status: "active" },
    });
  });

  it("creates projects and updates workspace configuration", async () => {
    const { web } = await setup();
    const workspaceUrl = `${web.origin}/api/workspaces/hub/investigations`;
    const initialResponse = await fetch(workspaceUrl);
    const initial = await initialResponse.json() as WebWorkspaceDetailResponse;

    const configured = await fetch(workspaceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: web.origin },
      body: JSON.stringify({
        operation: "configure",
        set: {
          description: "Updated investigations.",
          lead: "agents/lead",
          agents: ["agents/lead"],
        },
      }),
    });
    expect(await configured.json()).toMatchObject({
      workspace: {
        description: "Updated investigations.",
        agents: ["agents/lead"],
      },
    });

    const updated = await fetch(workspaceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: web.origin },
      body: JSON.stringify({
        operation: "update",
        patch: {
          guidance: "Prefer current primary evidence.",
          acceptance: ["Cite every material claim."],
        },
        etag: initial.detail.etag,
        commandId: "00000000-0000-4000-8000-000000000020",
      }),
    });
    expect(await updated.json()).toMatchObject({
      workspace: {
        guidance: "Prefer current primary evidence.",
        acceptance: ["Cite every material claim."],
      },
    });

    const created = await fetch(workspaceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: web.origin },
      body: JSON.stringify({
        operation: "create",
        project: "market-signals",
        title: "Market signals",
        goal: "Summarize current market signals.",
        tags: ["market"],
        commandId: "00000000-0000-4000-8000-000000000021",
      }),
    });
    expect(await created.json()).toMatchObject({
      project: {
        id: "market-signals",
        title: "Market signals",
        tags: ["market"],
      },
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
