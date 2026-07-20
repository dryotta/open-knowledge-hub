import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Gh } from "../src/git/gh.js";
import { Git } from "../src/git/git.js";
import { ContainerService } from "../src/container/service.js";
import { workspaceLoader } from "../src/modules/loaders/workspace.js";
import { buildServer } from "../src/server/index.js";
import { TodoService } from "../src/todos/service.js";
import { WorkspaceService } from "../src/workspaces/service.js";
import {
  makePaths,
  makeTempDir,
  testRun,
  writeModule,
} from "./helpers.js";

class FakeGh {
  async currentLogin(): Promise<string> { return "tester"; }
  async createRepo(): Promise<string> { return "x"; }
  async createPr(): Promise<string> { return "x"; }
}

const cleanups: string[] = [];
const clients: Client[] = [];
const servers: McpServer[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function command(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return ("structuredContent" in result
    ? (result as { structuredContent?: Record<string, unknown> }).structuredContent
    : undefined) ?? {};
}

function links(result: Awaited<ReturnType<Client["callTool"]>>): string[] {
  if (!("content" in result)) return [];
  return (result as CallToolResult).content
    .filter((entry): entry is Extract<CallToolResult["content"][number], { type: "resource_link" }> =>
      entry.type === "resource_link")
    .map((entry) => entry.uri);
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!("content" in result)) return "";
  return (result as CallToolResult).content
    .filter((entry): entry is Extract<CallToolResult["content"][number], { type: "text" }> =>
      entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

function isError(result: Awaited<ReturnType<Client["callTool"]>>): boolean {
  return "isError" in result && result.isError === true;
}

async function connect(): Promise<Client> {
  const home = await makeTempDir("okh-workspace-tool-home-");
  const root = await makeTempDir("okh-workspace-tool-container-");
  cleanups.push(home, root);
  const paths = makePaths(home);
  const containers = new ContainerService(
    paths,
    new Git(testRun),
    new FakeGh() as unknown as Gh,
  );
  await containers.addContainer({ source: root, name: "work", create: true });
  await writeModule(root, "agents", { type: "agents" });
  const agents = join(root, "agents", ".github", "agents");
  await mkdir(agents, { recursive: true });
  await writeFile(
    join(agents, "lead.agent.md"),
    "---\ndescription: Coordinates workspace runs\n---\n\nPlan and integrate.\n",
    "utf8",
  );
  await writeModule(root, "investigations", {
    type: "workspace",
    description: "Investigate evidence-based questions.",
    config: { lead: "agents/lead" },
  });
  await workspaceLoader.scaffold!(join(root, "investigations"));
  const workspaces = new WorkspaceService(
    containers,
    paths,
    () => new Date("2026-07-19T18:30:00.000Z"),
  );
  const server = await buildServer({
    paths,
    service: containers,
    todoService: new TodoService(containers),
    workspaceService: workspaces,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "workspace-tool-test", version: "0" });
  clients.push(client);
  servers.push(server);
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

describe("workspace MCP tool", () => {
  it("exposes all seven operations over one strict adapter with resource links", async () => {
    const client = await connect();
    const hub = await client.callTool({ name: "inspect", arguments: {} });
    expect(text(hub)).toContain("# Workspace project discovery");
    expect(text(hub)).toContain("Search all of them even after the first match.");

    const initialized = await client.callTool({
      name: "workspace",
      arguments: {
        operation: "create",
        container: "work",
        module: "investigations",
        guidance: "Prefer primary evidence.",
        acceptance: ["Material claims cite primary sources."],
        commandId: command(1),
      },
    });
    expect(isError(initialized)).toBe(false);
    expect(text(initialized)).toContain(
      'Required next step: before ending this request, call sync for container "work".',
    );

    const workspaceGet = await client.callTool({
      name: "workspace",
      arguments: { operation: "get", container: "work", module: "investigations" },
    });
    const workspaceEtag = structured(workspaceGet).etag as string;
    expect(links(workspaceGet)).toContain(
      "okh://containers/work/investigations/files/README.md",
    );
    const configured = await client.callTool({
      name: "workspace",
      arguments: {
        operation: "update",
        container: "work",
        module: "investigations",
        patch: { guidance: "Prefer direct primary evidence." },
        etag: workspaceEtag,
        commandId: command(2),
      },
    });
    expect(isError(configured)).toBe(false);
    expect(text(configured)).toContain(
      'Required next step: before ending this request, call sync for container "work".',
    );

    const created = await client.callTool({
      name: "workspace",
      arguments: {
        operation: "create",
        container: "work",
        module: "investigations",
        project: "supplier-risk",
        title: "Supplier risk",
        goal: "Recommend resilient alternatives.",
        commandId: command(3),
      },
    });
    const project = structured(created).project as { etag: string };
    expect(text(created)).toContain(
      'Required next step: before ending this request, call sync for container "work".',
    );
    const listed = await client.callTool({
      name: "workspace",
      arguments: {
        operation: "list",
        container: "work",
        module: "investigations",
        status: "active",
      },
    });
    expect((structured(listed).projects as Array<{ id: string }>)[0]?.id).toBe("supplier-risk");

    const started = await client.callTool({
      name: "workspace",
      arguments: {
        operation: "start",
        container: "work",
        module: "investigations",
        project: "supplier-risk",
        etag: project.etag,
        commandId: command(4),
      },
    });
    const startedData = structured(started) as {
      etag: string;
      resume: { runId: string };
    };
    const snapshotUri = links(started).find((uri) => uri.includes("%2Fsnapshot%2F"));
    expect(snapshotUri).toBeDefined();
    expect(text(started)).toContain("copy an exact URI into read_resource");
    expect(text(started)).toContain(snapshotUri);

    const paused = await client.callTool({
      name: "workspace",
      arguments: {
        operation: "report",
        container: "work",
        module: "investigations",
        project: "supplier-risk",
        run: startedData.resume.runId,
        state: "paused",
        checkpoint: { summary: "Need a decision.", question: "Use the lagged dataset?" },
        etag: startedData.etag,
        commandId: command(5),
      },
    });
    const guided = await client.callTool({
      name: "workspace",
      arguments: {
        operation: "intervene",
        container: "work",
        module: "investigations",
        project: "supplier-risk",
        run: startedData.resume.runId,
        action: "guide",
        guidance: "Use it and label the lag.",
        etag: structured(paused).etag,
        commandId: command(6),
      },
    });
    const failed = await client.callTool({
      name: "workspace",
      arguments: {
        operation: "report",
        container: "work",
        module: "investigations",
        project: "supplier-risk",
        run: startedData.resume.runId,
        state: "failed",
        reason: "No authoritative source was available.",
        etag: structured(guided).etag,
        commandId: command(7),
      },
    });
    expect((structured(failed).project as { activeRun: string | null }).activeRun).toBeNull();
  });

  it("rejects operation-specific fields instead of silently ignoring them", async () => {
    const client = await connect();
    const wrongOperation = await client.callTool({
      name: "workspace",
      arguments: {
        operation: "list",
        container: "work",
        module: "investigations",
        commandId: command(20),
      },
    });

    expect(isError(wrongOperation)).toBe(true);

    const wrongReportState = await client.callTool({
      name: "workspace",
      arguments: {
        operation: "report",
        container: "work",
        module: "investigations",
        project: "example",
        run: "2026-07-19-001",
        state: "failed",
        reason: "Failed.",
        resultPath: ".",
        etag: "sha256:old",
        commandId: command(21),
      },
    });
    expect(isError(wrongReportState)).toBe(true);

    const wrongInterventionAction = await client.callTool({
      name: "workspace",
      arguments: {
        operation: "intervene",
        container: "work",
        module: "investigations",
        project: "example",
        run: "2026-07-19-001",
        action: "cancel",
        guidance: "This field belongs to guide.",
        etag: "sha256:old",
        commandId: command(22),
      },
    });
    expect(isError(wrongInterventionAction)).toBe(true);
  });
});
