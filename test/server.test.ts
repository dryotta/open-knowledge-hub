import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
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
import { makePaths, makeTempDir, makeOrigin, testRun } from "./helpers.js";

class FakeGh {
  async currentLogin(): Promise<string> { return "tester"; }
  async findOpenPr(): Promise<string | undefined> { return undefined; }
  async createRepo(): Promise<string> { return "x"; }
  async createPr(): Promise<string> { return "https://github.com/test/x/pull/1"; }
}

const cleanups: string[] = [];
const servers: McpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function connect(options: { todoWebUrl?: string } = {}): Promise<{ client: Client; home: string }> {
  const home = await makeTempDir();
  cleanups.push(home);
  const paths = makePaths(home);
  const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
  const todoService = new TodoService(service, () => new Date("2026-07-10T08:00:00.000Z"));
  const server = await buildServer({
    service,
    paths,
    todoService,
    ...(options.todoWebUrl !== undefined ? { todoWebUrl: options.todoWebUrl } : {}),
  });
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

function normalizedWhitespace(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

describe("MCP server surface", () => {
  it("exposes exactly the 11 tools and no prompts", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "add_container",
      "add_module",
      "ask",
      "capabilities",
      "config",
      "context",
      "inspect",
      "onboard",
      "run",
      "sync",
      "todos",
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
    expect(byName.todos!.readOnlyHint).toBe(false);
    expect(byName.todos!.openWorldHint).toBe(false);
  });

  it("tool titles remain detectable in transcripts", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const config = tools.find((t) => t.name === "config");
    const todos = tools.find((t) => t.name === "todos");
    const configTitle = config?.title ?? (config?.annotations as { title?: string } | undefined)?.title ?? "";
    expect(configTitle).toMatch(/\bconfig\b/i);
    expect(todos?.title).toBeTruthy();
  });

  it("todos metadata preserves active remember/todo discipline and preview/apply sync boundaries", async () => {
    const { client } = await connect();
    const todos = (await client.listTools()).tools.find((t) => t.name === "todos");
    const description = normalizedWhitespace(todos?.description);
    expect(description).toContain("List, preview, create, or update Markdown todos in memory modules.");
    expect(description).toContain("Create and update return a preview without writing unless `apply: true` is supplied.");
    expect(description).toContain("Agent-driven requests present that preview and obtain confirmation before applying");
    expect(description).toContain("MCP App checkbox clicks may apply directly");
    expect(description).toContain('explicit remember requests use `skill: "remember"`');
    expect(description).toContain('other todo changes use `skill: "todo"`');
    expect(description).toContain("Agent-driven writes call `sync` afterward");
    expect(description).toContain("MCP App changes remain local until explicit sync");
  });

  it("todos metadata prevents mutation routing from bypassing the active skill", async () => {
    const { client } = await connect();
    const todos = (await client.listTools()).tools.find((t) => t.name === "todos");
    const description = normalizedWhitespace(todos?.description);
    expect(description).toContain("For a natural-language todo change, call `run` before `todos`");
    expect(description).toContain('explicit remember requests use `skill: "remember"`');
    expect(description).toContain('other todo changes use `skill: "todo"`');
  });

  it("publishes the todos MCP App metadata and bundled resource", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const todos = tools.find((tool) => tool.name === "todos");

    expect(todos?._meta?.ui).toEqual({
      resourceUri: "ui://open-knowledge-hub/todos",
      visibility: ["model", "app"],
    });

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

  it("links todos results to the hosted todo web UI", async () => {
    const webUrl = "http://127.0.0.1:43123/todos";
    const { client } = await connect({ todoWebUrl: webUrl });

    const result = await client.callTool({ name: "todos", arguments: {} });

    expect(textOf(result)).toContain(`Todo web UI: ${webUrl}`);
    expect(structuredOf(result)).toMatchObject({
      operation: "list",
      webUrl,
    });
  });

  it("todos previews then applies create and update operations with structured results", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);
    await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add_module", arguments: { container: "hub", path: "mem", type: "memory", name: "Mem", create: true } });
    await writeFile(join(dir, "mem", "warnings.md"), "- [ ] Broken dates #todo 📅 someday 📅 2026-07-12\n", "utf8");
    const target = join(dir, "mem", "2026-07-10.md");

    const preview = await client.callTool({
      name: "todos",
      arguments: {
        operation: "create",
        container: "hub",
        module: "mem",
        text: "Ship unified todos",
        labels: ["release"],
      },
    });
    expect(textOf(preview)).toMatch(/preview/i);
    expect(textOf(preview)).toContain("- [ ] Ship unified todos #todo #release ➕ 2026-07-10");
    expect(textOf(preview)).toContain("Explicit confirmation is required before applying this preview.");
    const previewStructured = structuredOf(preview) as {
      operation?: string;
      applied?: boolean;
      needsConfirmation?: boolean;
      preview?: {
        line: string;
        todo: { text: string; labels: string[]; source: { path: string; line: number } };
      };
    };
    expect(previewStructured).toMatchObject({
      operation: "create",
      applied: false,
      needsConfirmation: true,
      preview: {
        line: "- [ ] Ship unified todos #todo #release ➕ 2026-07-10",
        todo: {
          text: "Ship unified todos",
          labels: ["release"],
          source: { path: "2026-07-10.md", line: 3 },
        },
      },
    });
    await expect(readFile(target, "utf8")).rejects.toHaveProperty("code", "ENOENT");

    const created = await client.callTool({
      name: "todos",
      arguments: {
        operation: "create",
        container: "hub",
        module: "mem",
        text: "Ship unified todos",
        labels: ["release"],
        apply: true,
      },
    });
    expect(textOf(created)).toMatch(/created|applied/i);
    const createdStructured = structuredOf(created) as {
      operation?: string;
      applied?: boolean;
      todo?: { ref: string; text: string; labels: string[]; status: string; source: { path: string; line: number } };
      dirtyContainer?: string;
    };
    expect(createdStructured).toMatchObject({
      operation: "create",
      applied: true,
      dirtyContainer: "hub",
    });
    expect(createdStructured.todo).toMatchObject({
      text: "Ship unified todos",
      labels: ["release"],
      status: "open",
      source: { path: "2026-07-10.md", line: 3 },
    });
    expect(textOf(created)).toContain('Local change pending sync for container "hub". Agent-driven workflows must call sync now;');
    expect(await readFile(target, "utf8")).toContain("- [ ] Ship unified todos #todo #release ➕ 2026-07-10");

    const listed = await client.callTool({
      name: "todos",
      arguments: { container: "hub", module: "mem", labels: ["ship"], labelMode: "all" },
    });
    expect(textOf(listed)).toContain("Todos: 0 open, 0 completed, 0 custom.");
    const released = await client.callTool({
      name: "todos",
      arguments: { container: "hub", module: "mem", labels: ["release"], labelMode: "all" },
    });
    expect(textOf(released)).toContain("Todos: 1 open, 0 completed, 0 custom.");
    expect(textOf(released)).toContain("hub/mem");
    expect(textOf(released)).toContain("[ ] Ship unified todos #release (2026-07-10.md:3)");
    expect(textOf(released)).not.toContain("Broken dates");
    const listedStructured = structuredOf(released) as {
      operation?: string;
      tasks?: Array<{ text: string; labels: string[]; status: string }>;
      warnings?: Array<{ message: string; source: { path: string; line: number } }>;
      counts?: { total: number; open: number; completed: number; custom: number };
    };
    expect(listedStructured.operation).toBe("list");
    expect(listedStructured.tasks).toHaveLength(1);
    expect(listedStructured.tasks?.[0]).toMatchObject({
      text: "Ship unified todos",
      labels: ["release"],
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

    const completedPreview = await client.callTool({
      name: "todos",
      arguments: { operation: "update", ref: createdStructured.todo!.ref, completed: true },
    });
    expect(textOf(completedPreview)).toMatch(/preview/i);
    expect(structuredOf(completedPreview)).toMatchObject({
      operation: "update",
      applied: false,
      needsConfirmation: true,
      preview: {
        todo: {
          text: "Ship unified todos",
          status: "completed",
          completed: "2026-07-10",
        },
      },
    });

    const completed = await client.callTool({
      name: "todos",
      arguments: { operation: "update", ref: createdStructured.todo!.ref, completed: true, apply: true },
    });
    expect(textOf(completed)).toMatch(/completed|updated|applied/i);
    expect(structuredOf(completed)).toMatchObject({
      operation: "update",
      applied: true,
      dirtyContainer: "hub",
      todo: {
        text: "Ship unified todos",
        status: "completed",
        completed: "2026-07-10",
      },
    });

    const doneList = await client.callTool({
      name: "todos",
      arguments: { container: "hub", module: "mem", status: "completed" },
    });
    expect(textOf(doneList)).toContain("Todos: 0 open, 1 completed, 0 custom.");
    expect(textOf(doneList)).toContain("[x] Ship unified todos #release (2026-07-10.md:3)");
    expect(structuredOf(doneList)).toMatchObject({
      operation: "list",
      counts: { total: 1, open: 0, completed: 1, custom: 0 },
      tasks: [{ text: "Ship unified todos", status: "completed" }],
    });
  });

  it("surfaces conditional todos argument errors as MCP isError results", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);
    await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add_module", arguments: { container: "hub", path: "mem", type: "memory", name: "Mem", create: true } });

    const createError = await client.callTool({
      name: "todos",
      arguments: { operation: "create", container: "hub", module: "mem", text: "   " },
    });
    expect(isErrorResult(createError)).toBe(true);
    expect(textOf(createError)).toContain("[INVALID_ARGUMENT] text must be a non-blank string.");

    const listError = await client.callTool({
      name: "todos",
      arguments: { operation: "list", apply: true },
    });
    expect(isErrorResult(listError)).toBe(true);
    expect(textOf(listError)).toContain("[INVALID_ARGUMENT]");

    const implicitListError = await client.callTool({
      name: "todos",
      arguments: { text: "Missing operation means list" },
    });
    expect(isErrorResult(implicitListError)).toBe(true);
    expect(textOf(implicitListError)).toContain("[INVALID_ARGUMENT]");

    const created = await client.callTool({
      name: "todos",
      arguments: { operation: "create", container: "hub", module: "mem", text: "Patch me", apply: true },
    });
    const createFieldError = await client.callTool({
      name: "todos",
      arguments: { operation: "create", container: "hub", module: "mem", text: "Patch me again", dueAfter: "2026-07-10" },
    });
    expect(isErrorResult(createFieldError)).toBe(true);
    expect(textOf(createFieldError)).toContain("[INVALID_ARGUMENT]");

    const patchError = await client.callTool({
      name: "todos",
      arguments: {
        operation: "update",
        ref: (structuredOf(created) as { todo?: { ref: string } }).todo!.ref,
      },
    });
    expect(isErrorResult(patchError)).toBe(true);
    expect(textOf(patchError)).toContain("[INVALID_ARGUMENT] Todo update cannot be empty.");
  });

  it("describes non-status updates without claiming completion", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);
    await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add_module", arguments: { container: "hub", path: "mem", type: "memory", name: "Mem", create: true } });

    const created = await client.callTool({
      name: "todos",
      arguments: { operation: "create", container: "hub", module: "mem", text: "Adjust metadata", apply: true },
    });
    const ref = (structuredOf(created) as { todo?: { ref: string } }).todo!.ref;

    const completed = await client.callTool({
      name: "todos",
      arguments: { operation: "update", ref, completed: true, apply: true },
    });
    const completedRef = (structuredOf(completed) as { todo?: { ref: string } }).todo!.ref;

    const updated = await client.callTool({
      name: "todos",
      arguments: { operation: "update", ref: completedRef, labels: ["release"], apply: true },
    });
    expect(textOf(updated)).toContain("Updated todo");
    expect(textOf(updated)).not.toContain("Marked todo completed");
    expect(structuredOf(updated)).toMatchObject({
      operation: "update",
      applied: true,
      todo: { text: "Adjust metadata", status: "completed", labels: ["release"] },
    });
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
    expect(textOf(applied)).toContain("[local]");
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

  it("add_container rejects flat sync:'pr' at MCP schema level", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);
    const res = await client.callTool({ name: "add_container", arguments: { source: dir, sync: "pr" } });
    expect(isErrorResult(res)).toBe(true);
  });

  it("add_container structured shared sync preview shows mode and resolved branch", async () => {
    const { client } = await connect();
    const origin = await makeOrigin();
    cleanups.push(origin);
    const res = await client.callTool({
      name: "add_container",
      arguments: { source: origin, name: "hub", sync: { mode: "shared", config: { branch: "user/alice/hub" } } },
    });
    const text = textOf(res);
    expect(isErrorResult(res)).toBe(false);
    expect(text).toContain("shared");
    expect(text).toContain("user/alice/hub");
    expect(structuredOf(res).needsConfirmation).toBe(true);
  });

  it("add_container structured shared sync create persists the descriptor", async () => {
    const { client } = await connect();
    const origin = await makeOrigin();
    cleanups.push(origin);
    await client.callTool({
      name: "add_container",
      arguments: { source: origin, name: "hub", sync: { mode: "shared", config: { branch: "user/alice/hub" } }, create: true },
    });
    const inspect = await client.callTool({ name: "inspect", arguments: { container: "hub" } });
    const text = textOf(inspect);
    expect(text).toContain("shared");
    expect(text).toContain("user/alice/hub");
  });

  it("sync action without container returns INVALID_ARGUMENT", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "sync", arguments: { action: "publish-pr" } });
    expect(isErrorResult(res)).toBe(true);
    expect(textOf(res)).toContain("INVALID_ARGUMENT");
  });

  it("sync with publish-pr action reaches service and returns PR URL", async () => {
    const { client, home } = await connect();
    const origin = await makeOrigin();
    cleanups.push(origin);
    await client.callTool({
      name: "add_container",
      arguments: { source: origin, name: "hub", sync: { mode: "shared", config: { branch: "user/tester/hub" } }, create: true },
    });
    // Write a change so there is something to push
    const containerPath = join(home, "containers", "hub");
    await writeFile(join(containerPath, "note.md"), "hello", "utf8");
    const res = await client.callTool({ name: "sync", arguments: { container: "hub", action: "publish-pr" } });
    expect(isErrorResult(res)).toBe(false);
    expect(textOf(res)).toContain("/pull/");
  });

  it("inspect list shows structured sync mode and actions for shared container", async () => {
    const { client } = await connect();
    const origin = await makeOrigin();
    cleanups.push(origin);
    await client.callTool({
      name: "add_container",
      arguments: { source: origin, name: "hub", sync: { mode: "shared", config: { branch: "user/alice/hub" } }, create: true },
    });
    const res = await client.callTool({ name: "inspect", arguments: {} });
    const text = textOf(res);
    expect(text).toContain("shared");
    expect(text).toContain("user/alice/hub");
    expect(text).toContain("publish-pr");
  });

  it("inspect container shows structured sync and available actions", async () => {
    const { client } = await connect();
    const origin = await makeOrigin();
    cleanups.push(origin);
    await client.callTool({
      name: "add_container",
      arguments: { source: origin, name: "hub", sync: { mode: "shared", config: { branch: "user/alice/hub" } }, create: true },
    });
    const res = await client.callTool({ name: "inspect", arguments: { container: "hub" } });
    const text = textOf(res);
    expect(text).toContain("shared");
    expect(text).toContain("user/alice/hub");
    expect(text).toContain("publish-pr");
  });

  it("plain shared sync appends publish-pr guidance", async () => {
    const { client, home } = await connect();
    const origin = await makeOrigin();
    cleanups.push(origin);
    await client.callTool({
      name: "add_container",
      arguments: { source: origin, name: "hub", sync: { mode: "shared", config: { branch: "user/tester/hub" } }, create: true },
    });
    const containerPath = join(home, "containers", "hub");
    await writeFile(join(containerPath, "note.md"), "hello", "utf8");
    const res = await client.callTool({ name: "sync", arguments: { container: "hub" } });
    const text = textOf(res);
    expect(text).toContain('call sync with action "publish-pr"');
    expect(text).toContain("user/tester/hub");
  });

  it("publish-pr sync result does not append guidance", async () => {
    const { client, home } = await connect();
    const origin = await makeOrigin();
    cleanups.push(origin);
    await client.callTool({
      name: "add_container",
      arguments: { source: origin, name: "hub", sync: { mode: "shared", config: { branch: "user/tester/hub" } }, create: true },
    });
    const containerPath = join(home, "containers", "hub");
    await writeFile(join(containerPath, "note.md"), "hello", "utf8");
    const res = await client.callTool({ name: "sync", arguments: { container: "hub", action: "publish-pr" } });
    const text = textOf(res);
    expect(text).not.toContain('call sync with action "publish-pr"');
  });

  it("sync result format uses [backend/mode] prefix", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);
    await client.callTool({ name: "add_container", arguments: { source: dir, name: "notes", create: true } });
    const res = await client.callTool({ name: "sync", arguments: { container: "notes" } });
    expect(textOf(res)).toMatch(/\[local\/auto\]/);
  });

  it("sync-all result format uses [backend/mode] prefix", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);
    await client.callTool({ name: "add_container", arguments: { source: dir, name: "notes", create: true } });
    const res = await client.callTool({ name: "sync", arguments: {} });
    expect(textOf(res)).toMatch(/\[local\/auto\]/);
    expect(isErrorResult(res)).toBe(false);
  });
});
