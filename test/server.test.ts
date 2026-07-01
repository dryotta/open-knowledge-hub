import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server/index.js";
import { PackService } from "../src/packs/service.js";
import { Git } from "../src/git/git.js";
import { makePaths, makeTempDir, makeOrigin, testRun } from "./helpers.js";

const cleanups: string[] = [];
async function connect() {
  const home = await makeTempDir();
  cleanups.push(home);
  const paths = makePaths(home);
  const service = new PackService(paths, new Git(testRun));
  const server = buildServer({ paths, service });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, paths };
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function textOf(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

describe("MCP server surface", () => {
  it("exposes the expected tools and prompts", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const name of [
      "catalog_list",
      "catalog_add",
      "pack_install",
      "pack_uninstall",
      "pack_status",
      "pack_pull",
      "pack_path",
      "pack_create",
      "pack_publish",
      "pack_begin_change",
      "pack_commit",
      "pack_diff",
      "pack_open_pr",
      "ask",
      "learn",
      "review_update",
      "create",
    ]) {
      expect(tools).toContain(name);
    }
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["ask", "create", "learn", "review_update"]);
  });

  it("drives a full catalog + install roundtrip over MCP", async () => {
    const origin = await makeOrigin({ "knowledge/index.md": "# pack\n" });
    const { client, paths } = await connect();

    const empty = await client.callTool({ name: "catalog_list", arguments: {} });
    expect(textOf(empty)).toContain("empty");

    await client.callTool({ name: "catalog_add", arguments: { slug: "alpha", repoUrl: origin } });
    const install = await client.callTool({ name: "pack_install", arguments: { slug: "alpha" } });
    expect(textOf(install)).toContain("Installed");

    const path = await client.callTool({ name: "pack_path", arguments: { slug: "alpha" } });
    expect(textOf(path)).toBe(join(paths.packsDir, "alpha", "knowledge"));

    const status = await client.callTool({ name: "pack_status", arguments: { slug: "alpha" } });
    expect(textOf(status)).toContain("Branch: main");
  });

  it("returns discipline text from a flow tool", async () => {
    const origin = await makeOrigin({ "knowledge/index.md": "# pack\n" });
    const { client } = await connect();
    await client.callTool({ name: "pack_install", arguments: { slug: "alpha", repoUrl: origin } });

    const ask = await client.callTool({ name: "ask", arguments: { slug: "alpha", question: "Q?" } });
    expect(textOf(ask)).toContain("OKF Ask");
    expect(textOf(ask)).toContain("Q?");
  });

  it("surfaces OkhError as a clean tool error", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "pack_status", arguments: { slug: "ghost" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("NOT_FOUND");
  });

  it("renders a prompt with its discipline body", async () => {
    const origin = await makeOrigin({ "knowledge/index.md": "# pack\n" });
    const { client } = await connect();
    await client.callTool({ name: "pack_install", arguments: { slug: "alpha", repoUrl: origin } });

    const prompt = await client.getPrompt({ name: "learn", arguments: { slug: "alpha", knowledge: "new fact" } });
    const body = prompt.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
    expect(body).toContain("OKF Learn");
    expect(body).toContain("pull request");
  });
});

describe("scaffold output", () => {
  it("writes a conformant-ish skeleton index.md", async () => {
    const { client, paths } = await connect();
    await client.callTool({ name: "pack_create", arguments: { slug: "fresh", title: "Fresh" } });
    const idx = await readFile(join(paths.packsDir, "fresh", "knowledge", "index.md"), "utf8");
    expect(idx).toContain("okf_version");
    expect(idx).toContain("Goals");
    expect(idx).toContain("Target questions");
  });
});
