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
  it("exposes exactly the 9 tools and 5 prompts", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["add", "ask", "context", "inspect", "learn", "onboard", "reflect", "remember", "sync"]);

    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["ask", "context", "learn", "reflect", "remember"]);
  });

  it("onboard returns guidance without args and persists a wake phrase with args", async () => {
    const { client, home } = await connect();

    const guide = await client.callTool({ name: "onboard", arguments: {} });
    expect(textOf(guide)).toContain("OKH: onboard");
    expect(textOf(guide)).toContain("hub"); // default wake phrase

    const set = await client.callTool({ name: "onboard", arguments: { wakePhrase: "brain" } });
    expect(textOf(set)).toContain('Wake phrase set to "brain"');

    const { loadPreferences } = await import("../src/preferences.js");
    expect((await loadPreferences(makePaths(home))).wakePhrase).toBe("brain");

    const bad = await client.callTool({ name: "onboard", arguments: { wakePhrase: "no spaces" } });
    expect(isErrorResult(bad)).toBe(true);
  });

  it("declares accurate tool annotations", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(byName.inspect!.readOnlyHint).toBe(true);
    expect(byName.ask!.readOnlyHint).toBe(true);
    expect(byName.add!.openWorldHint).toBe(true);
    expect(byName.sync!.openWorldHint).toBe(true);
  });

  it("add -> inspect round-trips through the tool interface", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);

    await client.callTool({ name: "add", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add", arguments: { container: "hub", path: "kb", type: "knowledge", create: true } });
    const res = await client.callTool({ name: "inspect", arguments: {} });
    expect(textOf(res)).toContain("hub");

    const mod = await client.callTool({ name: "inspect", arguments: { container: "hub", module: "kb" } });
    expect(textOf(mod)).toContain("[knowledge]");
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
      arguments: { container: "hub", path: "kb", type: "knowledge" },
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
      arguments: { container: "hub", path: "", type: "knowledge" },
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
    await client.callTool({ name: "add", arguments: { container: "hub", path: "kb", type: "knowledge", create: true } });
    const res = await client.getPrompt({
      name: "ask",
      arguments: { container: "hub", question: "What is X?" },
    });
    const text = promptText(res);
    expect(text).toContain("What is X?");
    expect(text).toContain(join(dir, "kb"));
  });
});
