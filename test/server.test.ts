import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer } from "../src/server/index.js";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { savePreferences } from "../src/preferences.js";
import { TodoService } from "../src/todos/service.js";
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
const servers: McpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function connect(): Promise<{ client: Client; home: string }> {
  const home = await makeTempDir();
  cleanups.push(home);
  const paths = makePaths(home);
  const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
  const todoService = new TodoService(service, () => new Date("2026-07-10T08:00:00.000Z"));
  const server = await buildServer({ service, paths, todoService });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  servers.push(server);
  clients.push(client);
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return { client, home };
}

function textOf(res: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!("content" in res)) return "";
  return (res as CallToolResult).content
    .filter((c): c is Extract<CallToolResult["content"][number], { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function structuredOf(res: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return ("structuredContent" in res ? (res as { structuredContent?: Record<string, unknown> }).structuredContent : undefined) ?? {};
}

function isErrorResult(res: Awaited<ReturnType<Client["callTool"]>>): boolean {
  return "isError" in res && res.isError === true;
}

describe("MCP server surface", () => {
  it("exposes exactly the 11 tools and no prompts", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "add_container",
      "add_module",
      "ask",
      "config",
      "context",
      "inspect",
      "onboard",
      "run",
      "sync",
      "todos",
      "update_todo",
    ]);
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
  });

  it("tool titles/descriptions load from resources", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const add = tools.find((t) => t.name === "add_container")!;
    expect(add.description).toContain("returns a plan and makes no changes");
    const config = tools.find((t) => t.name === "config")!;
    expect(config.description).toContain("Known keys:");
    expect(config.description).not.toContain("{{");
  });

  it("add_module without create returns the workflow (no mutation)", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);

    await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
    const res = await client.callTool({ name: "add_module", arguments: {} });

    const text = textOf(res);
    expect(text).toContain('<discipline name="add_module">');
    expect(text).toContain("create: true");
    expect(structuredOf(res).needsConfirmation).toBeUndefined();
  });

  it("adding a knowledge module points at the initialize skill", async () => {
    const { client } = await connect();
    const source = await makeTempDir();
    cleanups.push(source);
    await client.callTool({ name: "add_container", arguments: { source, name: "hub", create: true } });
    const res = await client.callTool({
      name: "add_module",
      arguments: { container: "hub", path: "kb", type: "knowledge", name: "KB", create: true },
    });
    expect(textOf(res)).toMatch(/skill: "initialize"/);
  });

  it("adding a non-initialize type omits the initialize pointer", async () => {
    const { client } = await connect();
    const source = await makeTempDir();
    cleanups.push(source);
    await client.callTool({ name: "add_container", arguments: { source, name: "hub", create: true } });
    const res = await client.callTool({
      name: "add_module",
      arguments: { container: "hub", path: "sk", type: "skills", name: "SK", create: true },
    });
    expect(textOf(res)).not.toContain('skill: "initialize"');
  });

  it("onboard returns multi-turn guidance without args and does not mutate config", async () => {
    const { client, home } = await connect();
    const guide = await client.callTool({ name: "onboard", arguments: {} });
    expect(textOf(guide)).toContain("OKH: onboard");
    expect(textOf(guide)).toContain("hub"); // default wake phrase injected

    const { loadPreferences } = await import("../src/preferences.js");
    // onboard has no wakePhrase arg anymore; prefs remain default.
    expect((await loadPreferences(makePaths(home))).wakePhrase).toBe("hub");
  });

  it("config lists settings and persists changes via set", async () => {
    const { client, home } = await connect();

    const list = await client.callTool({ name: "config", arguments: {} });
    expect(textOf(list)).toContain("wakePhrase");
    expect(textOf(list)).toContain("hub");

    const set = await client.callTool({ name: "config", arguments: { set: { wakePhrase: "brain" } } });
    expect(textOf(set)).toContain("brain");

    const { loadPreferences } = await import("../src/preferences.js");
    expect((await loadPreferences(makePaths(home))).wakePhrase).toBe("brain");

    const badValue = await client.callTool({ name: "config", arguments: { set: { wakePhrase: "no spaces" } } });
    expect(isErrorResult(badValue)).toBe(true);

    const badKey = await client.callTool({ name: "config", arguments: { set: { nope: "x" } } });
    expect(isErrorResult(badKey)).toBe(true);
    expect(textOf(badKey)).toContain("wakePhrase"); // error lists valid keys

    const empty = await client.callTool({ name: "config", arguments: { set: {} } });
    expect(isErrorResult(empty)).toBe(true);
  });

  it("announces the configured wake phrase in server instructions", async () => {
    const home = await makeTempDir();
    cleanups.push(home);
    const paths = makePaths(home);
    await savePreferences(paths, { wakePhrase: "brain" });
    const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
    const server = await buildServer({ service, paths });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    servers.push(server);
    clients.push(client);
    await Promise.all([client.connect(clientT), server.connect(serverT)]);
    const instructions = client.getInstructions();
    expect(instructions).toContain("brain");
    expect(instructions).toContain("config");
  });

  it("declares accurate tool annotations", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(byName.inspect!.readOnlyHint).toBe(true);
    expect(byName.ask!.readOnlyHint).toBe(true);
    expect(byName.add_container!.openWorldHint).toBe(true);
    expect(byName.add_module!.openWorldHint).toBe(true);
    expect(byName.sync!.openWorldHint).toBe(true);
    expect(byName.onboard!.readOnlyHint).toBe(true);
    expect(byName.onboard!.openWorldHint).toBe(false);
    expect(byName.todos!.readOnlyHint).toBe(true);
    expect(byName.todos!.openWorldHint).toBe(false);
    expect(byName.update_todo!.readOnlyHint).toBe(false);
    expect(byName.update_todo!.openWorldHint).toBe(false);
  });

  it("tool titles remain detectable in transcripts", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const config = tools.find((t) => t.name === "config");
    const todos = tools.find((t) => t.name === "todos");
    const updateTodo = tools.find((t) => t.name === "update_todo");
    const configTitle = config?.title ?? (config?.annotations as { title?: string } | undefined)?.title ?? "";
    expect(configTitle).toMatch(/\bconfig\b/i);
    expect(todos?.title).toBe("Show todo lists");
    expect(updateTodo?.title).toBe("Update one todo");
  });

  it("update_todo metadata preserves the todo-skill and sync workflow", async () => {
    const { client } = await connect();
    const updateTodo = (await client.listTools()).tools.find((t) => t.name === "update_todo");
    expect(updateTodo?.description).toContain('first call `run { container, module, skill: "todo", input? }`');
    expect(updateTodo?.description).toContain("call `sync` after a successful write");
  });

  it("publishes the todos MCP App metadata and bundled resource", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const todos = tools.find((tool) => tool.name === "todos");
    const updateTodo = tools.find((tool) => tool.name === "update_todo");

    expect(todos?._meta?.ui).toEqual({
      resourceUri: "ui://open-knowledge-hub/todos",
      visibility: ["model", "app"],
    });
    expect(updateTodo?._meta?.ui).toEqual({ visibility: ["model", "app"] });

    const resource = await client.readResource({ uri: "ui://open-knowledge-hub/todos" });
    const content = resource.contents[0];
    expect(content).toMatchObject({
      uri: "ui://open-knowledge-hub/todos",
      mimeType: "text/html;profile=mcp-app",
      _meta: { ui: { prefersBorder: true } },
    });
    expect("text" in content! ? content.text : "").toContain("<title>Open Knowledge Hub Todos</title>");
    expect("text" in content! ? content.text : "").toContain('data-app="open-knowledge-hub-todos"');
    expect("text" in content! ? content.text : "").not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
  });

  it("update_todo and todos round-trip through the tool interface with structured results", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);
    await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add_module", arguments: { container: "hub", path: "mem", type: "memory", name: "Mem", create: true } });
    await writeFile(join(dir, "mem", "warnings.md"), "- [ ] Broken dates #todo 📅 someday 📅 2026-07-12\n", "utf8");

    const created = await client.callTool({
      name: "update_todo",
      arguments: {
        operation: "create",
        container: "hub",
        module: "mem",
        text: "Ship deterministic MCP todos",
        entrySummary: "Release prep",
        observation: "Track the adapter rollout.",
        labels: ["ship", "release"],
        due: "2026-07-12",
        priority: "high",
      },
    });
    expect(textOf(created)).toMatch(/created|added/i);
    const createdStructured = structuredOf(created) as {
      todo?: { ref: string; text: string; labels: string[]; due?: string; status: string; source: { path: string; line: number } };
      dirtyContainer?: string;
    };
    expect(createdStructured.dirtyContainer).toBe("hub");
    expect(createdStructured.todo).toMatchObject({
      text: "Ship deterministic MCP todos",
      labels: ["ship", "release"],
      due: "2026-07-12",
      status: "open",
      source: { path: "2026-07-10.md", line: 5 },
    });

    const listed = await client.callTool({
      name: "todos",
      arguments: { container: "hub", module: "mem", labels: ["ship"], labelMode: "all" },
    });
    expect(textOf(listed)).toContain("Todos: 1 open, 0 completed, 0 custom.");
    expect(textOf(listed)).toContain("hub/mem");
    expect(textOf(listed)).toContain("[ ] Ship deterministic MCP todos #ship #release due 2026-07-12 (2026-07-10.md:5)");
    expect(textOf(listed)).not.toContain("Broken dates");
    const listedStructured = structuredOf(listed) as {
      tasks?: Array<{ text: string; labels: string[]; status: string }>;
      warnings?: Array<{ message: string; source: { path: string; line: number } }>;
      counts?: { total: number; open: number; completed: number; custom: number };
    };
    expect(listedStructured.tasks).toHaveLength(1);
    expect(listedStructured.tasks?.[0]).toMatchObject({
      text: "Ship deterministic MCP todos",
      labels: ["ship", "release"],
      status: "open",
    });
    expect(listedStructured.warnings).toEqual([
      {
        source: { container: "hub", module: "mem", path: "warnings.md", line: 1 },
        message: 'Invalid due date "someday".',
      },
      {
        source: { container: "hub", module: "mem", path: "warnings.md", line: 1 },
        message: "Duplicate due date metadata found; using the last valid value.",
      },
    ]);
    expect(listedStructured.counts).toEqual({ total: 1, open: 1, completed: 0, custom: 0 });

    const completed = await client.callTool({
      name: "update_todo",
      arguments: { operation: "patch", ref: createdStructured.todo!.ref, completed: true },
    });
    expect(textOf(completed)).toMatch(/completed/i);
    expect(structuredOf(completed)).toMatchObject({
      dirtyContainer: "hub",
      todo: {
        text: "Ship deterministic MCP todos",
        status: "completed",
        completed: "2026-07-10",
      },
    });

    const doneList = await client.callTool({
      name: "todos",
      arguments: { container: "hub", module: "mem", status: "completed" },
    });
    expect(textOf(doneList)).toContain("Todos: 0 open, 1 completed, 0 custom.");
    expect(textOf(doneList)).toContain("[x] Ship deterministic MCP todos #ship #release due 2026-07-12 (2026-07-10.md:5)");
    expect(structuredOf(doneList)).toMatchObject({
      counts: { total: 1, open: 0, completed: 1, custom: 0 },
      tasks: [{ text: "Ship deterministic MCP todos", status: "completed" }],
    });
  });

  it("surfaces conditional update_todo argument errors as MCP isError results", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);
    await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add_module", arguments: { container: "hub", path: "mem", type: "memory", name: "Mem", create: true } });

    const createError = await client.callTool({
      name: "update_todo",
      arguments: { operation: "create", container: "hub", module: "mem", text: "   " },
    });
    expect(isErrorResult(createError)).toBe(true);
    expect(textOf(createError)).toContain("[INVALID_ARGUMENT] text must be a non-blank string.");

    const created = await client.callTool({
      name: "update_todo",
      arguments: { operation: "create", container: "hub", module: "mem", text: "Patch me" },
    });
    const patchError = await client.callTool({
      name: "update_todo",
      arguments: {
        operation: "patch",
        ref: (structuredOf(created) as { todo?: { ref: string } }).todo!.ref,
      },
    });
    expect(isErrorResult(patchError)).toBe(true);
    expect(textOf(patchError)).toContain("[INVALID_ARGUMENT] Todo patch cannot be empty.");
  });

  it("add -> inspect round-trips through the tool interface", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);

    await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add_module", arguments: { container: "hub", path: "kb", type: "knowledge", name: "KB", create: true } });
    const res = await client.callTool({ name: "inspect", arguments: {} });
    expect(textOf(res)).toContain("hub");
    expect(textOf(res)).toMatch(/knowledge · KB \(kb\)/);

    const mod = await client.callTool({ name: "inspect", arguments: { container: "hub", module: "kb" } });
    expect(textOf(mod)).toContain("[knowledge]");
    expect(textOf(mod)).toContain("KB");
  });

  it("module inspect shows the scope contract / overview", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);
    await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add_module", arguments: { container: "hub", path: "kb", type: "knowledge", name: "KB", create: true } });
    const res = await client.callTool({ name: "inspect", arguments: { container: "hub", module: "kb" } });
    expect(textOf(res)).toContain("Scope / overview:");
    expect(textOf(res)).toMatch(/okf_version|Knowledge module/);
  });

  it("add previews (no changes) without create, and applies with create", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);

    const preview = await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub" } });
    expect(textOf(preview)).toContain("Plan (no changes made)");
    expect(textOf(preview)).toContain("add_container");
    expect(structuredOf(preview).needsConfirmation).toBe(true);

    const applied = await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
    expect(textOf(applied)).toContain('Registered container "hub"');
  });

  it("rejects a module inspect request without a container", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "inspect", arguments: { module: "kb" } });
    expect(isErrorResult(res)).toBe(true);
    expect(textOf(res)).toContain("Inspecting a module requires { container, module }.");
  });

  it("rejects an empty module inspect request without a container", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "inspect", arguments: { module: "" } });
    expect(isErrorResult(res)).toBe(true);
    expect(textOf(res)).toContain("Inspecting a module requires { container, module }.");
  });

  it("rejects add requests with empty source/path fields", async () => {
    const { client } = await connect();
    const emptySource = await client.callTool({ name: "add_container", arguments: { source: "" } });
    expect(isErrorResult(emptySource)).toBe(true);
    expect(textOf(emptySource)).toContain("source cannot be empty");

    const emptyPath = await client.callTool({
      name: "add_module",
      arguments: { container: "hub", path: "", type: "knowledge", name: "KB", create: true },
    });
    expect(isErrorResult(emptyPath)).toBe(true);
    expect(textOf(emptyPath)).toContain("path cannot be empty");
  });

  it("rejects sync requests with an empty container", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "sync", arguments: { container: "" } });
    expect(isErrorResult(res)).toBe(true);
    expect(textOf(res)).toContain("container cannot be empty");
  });

  it("the ask tool returns discipline text pointing at resolved paths", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);
    await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add_module", arguments: { container: "hub", path: "kb", type: "knowledge", name: "KB", create: true } });
    const res = await client.callTool({ name: "ask", arguments: { container: "hub", question: "What is X?" } });
    const text = textOf(res);
    expect(text).toContain("What is X?");
    expect(text).toContain(join(dir, "kb"));
  });

  it("does not register learn, remember, or reflect tools", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("learn");
    expect(tools).not.toContain("remember");
    expect(tools).not.toContain("reflect");
  });

  it("run tool returns discipline for a memory module skill", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);

    await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add_module", arguments: { container: "hub", path: "mem", type: "memory", name: "Mem", create: true } });

    const res = await client.callTool({
      name: "run",
      arguments: { container: "hub", module: "mem", skill: "remember", input: "User prefers dark mode" },
    });
    const text = textOf(res);
    expect(text).toContain("remember");
    expect(text).toContain("User prefers dark mode");
    expect(text).toContain("mem");
    expect(text).toMatch(/append|timestamp/i);
  });
});
