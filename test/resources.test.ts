import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server/index.js";
import { ContainerService } from "../src/container/service.js";
import { resolvePaths } from "../src/config.js";
import { TodoService } from "../src/todos/service.js";
import { moduleFileUri, moduleUri } from "../src/resources/uris.js";
import { MAX_RESOURCE_FILE_BYTES } from "../src/resources/moduleFiles.js";

const cleanups: string[] = [];
const clients: Client[] = [];
const servers: McpServer[] = [];

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(path);
  return path;
}

async function connectWithKnowledgeModule(): Promise<{
  client: Client;
  root: string;
}> {
  const root = await tempDir("okh-resource-module-");
  const home = await tempDir("okh-resource-home-");
  const paths = resolvePaths({ OKH_HOME: home });
  const service = new ContainerService(paths);
  await service.addContainer({ source: root, name: "hub", create: true });
  await service.addModule({
    container: "hub",
    path: "kb",
    name: "Knowledge",
    type: "knowledge",
    description: "Team knowledge",
    create: true,
  });

  await mkdir(join(root, "kb", "concepts"), { recursive: true });
  await writeFile(join(root, "kb", "concepts", "auth.md"), "# Authentication\n\nUse passkeys.\n");
  await writeFile(join(root, "kb", "logo.bin"), Buffer.from([0, 255, 16, 32]));

  const server = await buildServer({
    service,
    paths,
    todoService: new TodoService(service),
  });
  const client = new Client({ name: "resource-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  clients.push(client);
  servers.push(server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, root };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MCP resources", () => {
  it("lists direct resources and dynamic templates without flattening module files", async () => {
    const { client } = await connectWithKnowledgeModule();
    expect(client.getServerCapabilities()?.resources).toMatchObject({ listChanged: true });
    expect(client.getServerCapabilities()?.resources).not.toHaveProperty("subscribe");
    const listed = await client.listResources();
    const uris = listed.resources.map((resource) => resource.uri);

    expect(uris).toContain("okh://containers");
    expect(uris).not.toContain("okh://hub");
    expect(uris).toContain("okh://docs/index.md");
    expect(uris).toContain("okh://instructions/index.md");
    expect(uris).toContain("okh://instructions/okf/writer.md");
    expect(uris).not.toContain(moduleFileUri("hub", "kb", "concepts/auth.md"));

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual(
      expect.arrayContaining([
        "okh://containers/{container}",
        "okh://containers/{container}/{module}",
        "okh://containers/{container}/{module}/files/{path}",
      ]),
    );
  });

  it("reads the container index, text module files, and binary module files", async () => {
    const { client } = await connectWithKnowledgeModule();

    const containers = await client.readResource({ uri: "okh://containers" });
    expect(containers.contents[0]).toMatchObject({
      uri: "okh://containers",
      mimeType: "text/markdown",
    });
    expect("text" in containers.contents[0] ? containers.contents[0].text : "")
      .toContain("# Containers");
    await expect(client.readResource({ uri: "okh://hub" })).rejects.toThrow(/not found/);
    await expect(
      client.readResource({ uri: "okh://containers/hub/modules/kb" }),
    ).rejects.toThrow(/not found/);

    const moduleIndex = await client.readResource({ uri: moduleUri("hub", "kb") });
    const indexText = "text" in moduleIndex.contents[0] ? moduleIndex.contents[0].text : "";
    expect(indexText).toContain(moduleFileUri("hub", "kb", "concepts/auth.md"));

    const text = await client.readResource({ uri: moduleFileUri("hub", "kb", "concepts/auth.md") });
    expect(text.contents[0]).toMatchObject({ mimeType: "text/markdown" });
    expect("text" in text.contents[0] ? text.contents[0].text : "").toContain("Use passkeys.");

    const binary = await client.readResource({ uri: moduleFileUri("hub", "kb", "logo.bin") });
    expect(binary.contents[0]).toMatchObject({
      mimeType: "application/octet-stream",
      blob: Buffer.from([0, 255, 16, 32]).toString("base64"),
    });
  });

  it("emits valid links for punctuation, Unicode, percent signs, and nested paths", async () => {
    const { client, root } = await connectWithKnowledgeModule();
    const paths = [
      "concepts/a).md",
      "concepts/[guide] %.md",
      "concepts/\u65e5\u672c\u8a9e.md",
    ];
    for (const path of paths) {
      await writeFile(join(root, "kb", ...path.split("/")), `# ${path}\n`);
    }

    const moduleIndex = await client.readResource({ uri: moduleUri("hub", "kb") });
    const indexText = "text" in moduleIndex.contents[0] ? moduleIndex.contents[0].text : "";
    for (const path of paths) {
      const uri = moduleFileUri("hub", "kb", path);
      expect(indexText).toContain(`(<${uri}>)`);
      const resource = await client.readResource({ uri });
      expect("text" in resource.contents[0] ? resource.contents[0].text : "").toContain(path);
    }
    expect(indexText).toContain("\\[guide\\] %.md");
    expect(moduleFileUri("hub", "kb", "concepts/a).md")).toContain("a%29.md");
  });

  it("notifies clients when the dynamic hub resource list changes", async () => {
    const { client } = await connectWithKnowledgeModule();
    let notified!: () => void;
    const notification = new Promise<void>((resolve) => {
      notified = resolve;
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      notified();
    });

    await client.callTool({
      name: "add_module",
      arguments: {
        container: "hub",
        path: "notes",
        type: "knowledge",
        description: "Notes",
        create: true,
      },
    });
    await notification;

    const uris = (await client.listResources()).resources.map((resource) => resource.uri);
    expect(uris).toContain(moduleUri("hub", "notes"));
  });

  it("rejects traversal, absolute paths, NUL bytes, and hidden control files without leaking paths", async () => {
    const { client, root } = await connectWithKnowledgeModule();

    for (const path of ["../outside.txt", "C:/Windows/win.ini", "\0secret", ".okh/module.yaml"]) {
      let failure: unknown;
      try {
        await client.readResource({ uri: moduleFileUri("hub", "kb", path) });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(String(failure)).toMatch(/Resource not found|Invalid module file path/);
      expect(String(failure)).not.toContain(root);
    }
  });

  it("does not load an overview symlink that escapes the module", async () => {
    const { client, root } = await connectWithKnowledgeModule();
    const outside = join(root, "outside.md");
    const index = join(root, "kb", "index.md");
    await writeFile(outside, "# External secret\n");
    await rm(index);
    try {
      await symlink(outside, index, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const moduleIndex = await client.readResource({ uri: moduleUri("hub", "kb") });
    const text = "text" in moduleIndex.contents[0] ? moduleIndex.contents[0].text : "";
    expect(text).not.toContain("External secret");
    await expect(
      client.readResource({ uri: moduleFileUri("hub", "kb", "index.md") }),
    ).rejects.toThrow(/Resource not found/);
  });

  it("applies the module-file size limit to module overviews", async () => {
    const { client, root } = await connectWithKnowledgeModule();
    await writeFile(
      join(root, "kb", "index.md"),
      Buffer.alloc(MAX_RESOURCE_FILE_BYTES + 1, "a"),
    );

    await expect(
      client.readResource({ uri: moduleUri("hub", "kb") }),
    ).rejects.toThrow(/maximum readable size/);
  });

  it("returns documentation and common instruction links from help", async () => {
    const { client } = await connectWithKnowledgeModule();
    const result = await client.callTool({
      name: "help",
      arguments: { question: "How do I ingest source documents?" },
    });
    const links = result.content
      .filter((item) => item.type === "resource_link")
      .map((item) => item.type === "resource_link" ? item.uri : "");

    expect(links.some((uri) => uri.startsWith("okh://docs/"))).toBe(true);
    expect(links).toContain("okh://instructions/ingest.md");
  });

  it("links common and local skill resources from run", async () => {
    const { client, root } = await connectWithKnowledgeModule();
    const localSkillDir = join(root, "kb", ".okh", "skills", "custom");
    await mkdir(localSkillDir, { recursive: true });
    await writeFile(
      join(localSkillDir, "SKILL.md"),
      "---\nname: custom\ndescription: Local custom discipline\n---\nRead [the rubric](rubric.md).\n",
    );
    await writeFile(join(localSkillDir, "rubric.md"), "# Rubric\n\nBe precise.\n");

    const initialize = await client.callTool({
      name: "run",
      arguments: { container: "hub", module: "kb", skill: "initialize" },
    });
    const initializeLinks = initialize.content
      .filter((item) => item.type === "resource_link")
      .map((item) => item.type === "resource_link" ? item.uri : "");
    expect(initializeLinks).toEqual(expect.arrayContaining([
      "okh://instructions/grilling.md",
      "okh://instructions/ingest.md",
      "okh://instructions/okf/writer.md",
    ]));

    const custom = await client.callTool({
      name: "run",
      arguments: { container: "hub", module: "kb", skill: "custom" },
    });
    const localUri = moduleFileUri("hub", "kb", ".okh/skills/custom/rubric.md");
    expect(custom.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "resource_link", uri: localUri }),
    ]));

    const rubric = await client.readResource({ uri: localUri });
    expect("text" in rubric.contents[0] ? rubric.contents[0].text : "").toContain("Be precise.");
  });
});
