import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
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
  const server = buildServer({ service, paths });
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

function promptText(res: Awaited<ReturnType<Client["getPrompt"]>>): string {
  return res.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
}

function structuredOf(res: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return ("structuredContent" in res ? (res as { structuredContent?: Record<string, unknown> }).structuredContent : undefined) ?? {};
}

function isErrorResult(res: Awaited<ReturnType<Client["callTool"]>>): boolean {
  return "isError" in res && res.isError === true;
}

describe("MCP server surface", () => {
  it("exposes exactly the 8 tools and 4 prompts", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["add", "ask", "config", "context", "inspect", "onboard", "run", "sync"]);

    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["ask", "context", "onboard", "run"]);
  });

  it("adding a knowledge module points at the initialize skill", async () => {
    const { client } = await connect();
    const source = await makeTempDir();
    cleanups.push(source);
    await client.callTool({ name: "add", arguments: { source, name: "hub", create: true } });
    const res = await client.callTool({
      name: "add",
      arguments: { container: "hub", path: "kb", type: "knowledge", name: "KB", create: true },
    });
    expect(textOf(res)).toMatch(/skill: "initialize"/);
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
    const server = buildServer({ service, paths });
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
    expect(byName.add!.openWorldHint).toBe(true);
    expect(byName.sync!.openWorldHint).toBe(true);
    expect(byName.onboard!.readOnlyHint).toBe(true);
    expect(byName.onboard!.openWorldHint).toBe(false);
  });

  it("config tool title contains the word 'config' so its call is detectable in transcripts", async () => {
    const { client } = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === "config");
    const title = tool?.title ?? (tool?.annotations as { title?: string } | undefined)?.title ?? "";
    expect(title).toMatch(/\bconfig\b/i);
  });

  it("add -> inspect round-trips through the tool interface", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);

    await client.callTool({ name: "add", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add", arguments: { container: "hub", path: "kb", type: "knowledge", name: "KB", create: true } });
    const res = await client.callTool({ name: "inspect", arguments: {} });
    expect(textOf(res)).toContain("hub");

    const mod = await client.callTool({ name: "inspect", arguments: { container: "hub", module: "kb" } });
    expect(textOf(mod)).toContain("[knowledge]");
    expect(textOf(mod)).toContain("KB");
  });

  it("add previews (no changes) without create, and applies with create", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);

    const preview = await client.callTool({ name: "add", arguments: { source: dir, name: "hub" } });
    expect(textOf(preview)).toContain("Plan (no changes made)");
    expect(structuredOf(preview).needsConfirmation).toBe(true);

    const applied = await client.callTool({ name: "add", arguments: { source: dir, name: "hub", create: true } });
    expect(textOf(applied)).toContain('Registered container "hub"');
  });

  it("add previews module changes without create", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);

    await client.callTool({ name: "add", arguments: { source: dir, name: "hub", create: true } });
    const preview = await client.callTool({
      name: "add",
      arguments: { container: "hub", path: "kb", type: "knowledge", name: "KB" },
    });

    expect(textOf(preview)).toContain("Plan (no changes made)");
    expect(structuredOf(preview).needsConfirmation).toBe(true);
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

  it("rejects add requests that mix container and module modes", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);

    const res = await client.callTool({
      name: "add",
      arguments: { source: dir, name: "hub", container: "hub", path: "kb", type: "knowledge" },
    });
    expect(isErrorResult(res)).toBe(true);
    expect(textOf(res)).toContain("add requires either { source } or { container, path, type }, not both.");
  });

  it("rejects add requests that mix source with empty module fields", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);

    const res = await client.callTool({
      name: "add",
      arguments: { source: dir, container: "" },
    });
    expect(isErrorResult(res)).toBe(true);
    expect(textOf(res)).toContain("add requires either { source } or { container, path, type }, not both.");
  });

  it("rejects add requests with empty source/path fields", async () => {
    const { client } = await connect();
    const emptySource = await client.callTool({ name: "add", arguments: { source: "" } });
    expect(isErrorResult(emptySource)).toBe(true);
    expect(textOf(emptySource)).toContain("source cannot be empty");

    const emptyPath = await client.callTool({
      name: "add",
      arguments: { container: "hub", path: "", type: "knowledge", name: "KB" },
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

  it("the ask prompt returns discipline text pointing at resolved paths", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);

    await client.callTool({ name: "add", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add", arguments: { container: "hub", path: "kb", type: "knowledge", name: "KB", create: true } });
    const res = await client.getPrompt({
      name: "ask",
      arguments: { container: "hub", question: "What is X?" },
    });
    const text = promptText(res);
    expect(text).toContain("What is X?");
    expect(text).toContain(join(dir, "kb"));
  });

  it("exposes the onboard prompt", async () => {
    const { client } = await connect();
    const res = await client.getPrompt({ name: "onboard", arguments: {} });
    expect(promptText(res)).toContain("OKH: onboard");
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

    await client.callTool({ name: "add", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add", arguments: { container: "hub", path: "mem", type: "memory", name: "Mem", create: true } });

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
