import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ResourceListChangedNotificationSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server/index.js";
import { ContainerService } from "../src/container/service.js";
import { resolvePaths } from "../src/config.js";
import { TodoService } from "../src/todos/service.js";
import { moduleFileUri, moduleUri } from "../src/resources/uris.js";
import {
  MAX_MODULE_INDEX_FILES,
  MAX_RESOURCE_FILE_BYTES,
} from "../src/resources/moduleFiles.js";
import {
  MAX_MODULE_OVERVIEW_BYTES,
  MAX_MODULE_RESOURCE_BYTES,
} from "../src/resources/hub.js";
import {
  embedResourceLinks,
  MAX_EMBEDDED_RESOURCE_BYTES,
} from "../src/resources/embedding.js";

const cleanups: string[] = [];
const clients: Client[] = [];
const servers: McpServer[] = [];

function toolContent(
  result: Awaited<ReturnType<Client["callTool"]>>,
): CallToolResult["content"] {
  return "content" in result ? (result as CallToolResult).content : [];
}

function embeddedText(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string {
  return toolContent(result)
    .filter((item) => item.type === "resource" && "text" in item.resource)
    .map((item) => item.type === "resource" && "text" in item.resource
      ? item.resource.text
      : "")
    .join("\n");
}

function embeddedUris(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string[] {
  return toolContent(result)
    .filter((item) => item.type === "resource")
    .map((item) => item.type === "resource" ? item.resource.uri : "");
}

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(path);
  return path;
}

async function connectWithKnowledgeModule(): Promise<{
  client: Client;
  root: string;
  service: ContainerService;
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
  return { client, root, service };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MCP resources", () => {
  it("defers known oversized embeddings without invoking their read callbacks", async () => {
    const read = vi.fn(async () => ({
      contents: [{
        uri: "okh://docs/oversized.md",
        mimeType: "text/markdown",
        text: "must not be read",
      }],
    }));
    const selected = await embedResourceLinks(
      [{
        type: "resource_link",
        uri: "okh://docs/oversized.md",
        name: "oversized",
        size: MAX_EMBEDDED_RESOURCE_BYTES + 1,
      }],
      read,
    );

    expect(read).not.toHaveBeenCalled();
    expect(selected.embeddedResources).toEqual([]);
    expect(selected.deferredUris).toEqual(["okh://docs/oversized.md"]);
  });

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

  it("adapts text and binary resources into bounded embedded tool results", async () => {
    const { client } = await connectWithKnowledgeModule();
    const textUri = moduleFileUri("hub", "kb", "concepts/auth.md");
    const text = await client.callTool({
      name: "read_resource",
      arguments: { uri: textUri },
    });
    expect(toolContent(text)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "resource",
        resource: expect.objectContaining({
          uri: textUri,
          mimeType: "text/markdown",
          text: expect.stringContaining("Use passkeys."),
        }),
      }),
    ]));
    expect((text as CallToolResult).structuredContent).toMatchObject({
      uri: textUri,
      contentIndex: 0,
      contentCount: 1,
      offset: 0,
      totalBytes: expect.any(Number),
    });

    const binaryUri = moduleFileUri("hub", "kb", "logo.bin");
    const binary = await client.callTool({
      name: "read_resource",
      arguments: { uri: binaryUri },
    });
    expect(toolContent(binary)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "resource",
        resource: expect.objectContaining({
          uri: binaryUri,
          mimeType: "application/octet-stream",
          blob: Buffer.from([0, 255, 16, 32]).toString("base64"),
        }),
      }),
    ]));
  });

  it("continues large UTF-8 resources from nextOffset without splitting characters", async () => {
    const { client, root } = await connectWithKnowledgeModule();
    const original = "é日本".repeat(1_000);
    const path = "concepts/unicode.md";
    await writeFile(join(root, "kb", "concepts", "unicode.md"), original);
    const uri = moduleFileUri("hub", "kb", path);
    let offset = 0;
    let reconstructed = "";

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await client.callTool({
        name: "read_resource",
        arguments: { uri, offset, maxBytes: 257 },
      });
      const block = toolContent(result).find((item) => item.type === "resource");
      expect(block?.type).toBe("resource");
      if (!block || block.type !== "resource" || !("text" in block.resource)) break;
      expect(Buffer.byteLength(block.resource.text)).toBeLessThanOrEqual(257);
      reconstructed += block.resource.text;

      const structured = (result as CallToolResult).structuredContent as
        | { nextOffset?: number }
        | undefined;
      if (structured?.nextOffset === undefined) break;
      expect(structured.nextOffset).toBeGreaterThan(offset);
      offset = structured.nextOffset;
    }
    expect(reconstructed).toBe(original);

    const invalidBoundary = await client.callTool({
      name: "read_resource",
      arguments: { uri, offset: 1, maxBytes: 256 },
    });
    expect(invalidBoundary).toMatchObject({ isError: true });
    expect(toolContent(invalidBoundary)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("UTF-8 character boundary"),
      }),
    ]));
  });

  it("rejects unsupported and unknown read_resource URIs", async () => {
    const { client } = await connectWithKnowledgeModule();
    const unsupported = await client.callTool({
      name: "read_resource",
      arguments: { uri: "https://example.com/guide.md" },
    });
    expect(unsupported).toMatchObject({ isError: true });
    expect(toolContent(unsupported)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("only accepts okh:// URIs"),
      }),
    ]));

    const missing = await client.callTool({
      name: "read_resource",
      arguments: { uri: "okh://docs/missing.md" },
    });
    expect(missing).toMatchObject({ isError: true });
    expect(toolContent(missing)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Resource not found"),
      }),
    ]));
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

  it("notifies clients when module resource metadata changes", async () => {
    const { client } = await connectWithKnowledgeModule();
    let notified!: () => void;
    const notification = new Promise<void>((resolve) => {
      notified = resolve;
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      notified();
    });

    await client.callTool({
      name: "config",
      arguments: {
        container: "hub",
        module: "kb",
        set: { description: "Updated knowledge description" },
      },
    });
    await notification;

    const listed = await client.listResources();
    expect(listed.resources.find((resource) => resource.uri === moduleUri("hub", "kb")))
      .toMatchObject({ description: "Updated knowledge description" });
  });

  it("notifies for the final state of concurrent module description changes", async () => {
    const { client } = await connectWithKnowledgeModule();
    let notifications = 0;
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      notifications += 1;
    });

    await Promise.all([
      client.callTool({
        name: "config",
        arguments: {
          container: "hub",
          module: "kb",
          set: { description: "Temporary description" },
        },
      }),
      client.callTool({
        name: "config",
        arguments: {
          container: "hub",
          module: "kb",
          set: { description: "Team knowledge" },
        },
      }),
    ]);

    expect(notifications).toBe(2);
    const listed = await client.listResources();
    expect(listed.resources.find((resource) => resource.uri === moduleUri("hub", "kb")))
      .toMatchObject({ description: "Team knowledge" });
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

  it("omits oversized module overviews without failing the module resource", async () => {
    const { client, root } = await connectWithKnowledgeModule();
    await writeFile(
      join(root, "kb", "index.md"),
      Buffer.alloc(MAX_RESOURCE_FILE_BYTES + 1, "a"),
    );

    const moduleIndex = await client.readResource({ uri: moduleUri("hub", "kb") });
    const text = "text" in moduleIndex.contents[0] ? moduleIndex.contents[0].text : "";
    expect(text).toContain("Overview omitted");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_MODULE_RESOURCE_BYTES);
    await expect(
      client.readResource({ uri: moduleFileUri("hub", "kb", "index.md") }),
    ).rejects.toThrow(/maximum readable size/);
  });

  it("omits malformed UTF-8 overviews without expanding the module response", async () => {
    const { client, root } = await connectWithKnowledgeModule();
    await writeFile(
      join(root, "kb", "index.md"),
      Buffer.alloc(MAX_MODULE_OVERVIEW_BYTES, 0xff),
    );

    const moduleIndex = await client.readResource({ uri: moduleUri("hub", "kb") });
    const text = "text" in moduleIndex.contents[0] ? moduleIndex.contents[0].text : "";
    expect(text).toContain("not valid UTF-8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_MODULE_RESOURCE_BYTES);
  });

  it("loads the overview independently while bounding a large module file list", async () => {
    const { client, root } = await connectWithKnowledgeModule();
    await rm(join(root, "kb", "index.md"));
    const bulk = join(root, "kb", "bulk");
    await mkdir(bulk);
    for (let start = 0; start < MAX_MODULE_INDEX_FILES; start += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) => {
          const index = start + offset;
          return writeFile(join(bulk, `file-${index.toString().padStart(4, "0")}.txt`), "x");
        }),
      );
    }
    await writeFile(join(root, "kb", "index.md"), "# Late overview\n");

    const resource = await client.readResource({ uri: moduleUri("hub", "kb") });
    const text = "text" in resource.contents[0] ? resource.contents[0].text : "";
    expect(text).toContain("Late overview");
    expect(text).toContain("File list truncated");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_MODULE_RESOURCE_BYTES);
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
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.type === "text" ? item.text : "")
      .join("\n");
    expect(embeddedText(result)).toContain("## Stage 5 — Confirm the routing plan");
    expect(text).toContain("embedded in this tool result");
    expect(text).toMatch(/never open an `okh:\/\/`\s+URI with filesystem or web tools/u);
  });

  it("does not attach unrelated common instructions to generic help questions", async () => {
    const { client } = await connectWithKnowledgeModule();
    for (const question of [
      "How do I configure the wake phrase?",
      "Where is the web UI?",
      "Where is the user interface?",
      "How do I change user settings?",
    ]) {
      const result = await client.callTool({ name: "help", arguments: { question } });
      const links = result.content
        .filter((item) => item.type === "resource_link")
        .map((item) => item.type === "resource_link" ? item.uri : "");
      expect(links.some((uri) => uri.startsWith("okh://docs/"))).toBe(true);
      expect(links.some((uri) => uri.startsWith("okh://instructions/"))).toBe(false);
      expect(embeddedText(result)).not.toContain("# Grilling");
    }
  });

  it("includes selected common instruction content directly in help", async () => {
    const { client } = await connectWithKnowledgeModule();
    const result = await client.callTool({
      name: "help",
      arguments: { question: "Stress-test this plan one decision at a time" },
    });
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.type === "text" ? item.text : "")
      .join("\n");

    expect(embeddedText(result)).toContain("# Grilling");
    expect(embeddedText(result)).toContain("Ask questions **one decision at a time**");
    expect(embeddedText(result)).toContain("provide your recommended answer");
    expect(text).toMatch(/never open an `okh:\/\/`\s+URI with filesystem or web tools/u);
  });

  it("links common, dynamic, and local skill resources from run", async () => {
    const { client, root } = await connectWithKnowledgeModule();
    const localSkillDir = join(root, "kb", ".okh", "skills", "custom");
    const moduleDependency = moduleUri("hub", "kb");
    const fileDependency = moduleFileUri("hub", "kb", "concepts/auth.md");
    await mkdir(localSkillDir, { recursive: true });
    await writeFile(
      join(localSkillDir, "SKILL.md"),
      `---\nname: custom\ndescription: Local custom instructions\nresources:\n  - ${moduleDependency}\n  - ${fileDependency}\n---\nRead [the rubric](rubric.md).\n`,
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
    expect(embeddedUris(initialize)).toEqual(expect.arrayContaining([
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
      expect.objectContaining({ type: "resource_link", uri: moduleDependency }),
      expect.objectContaining({ type: "resource_link", uri: fileDependency }),
    ]));
    expect(embeddedUris(custom)).toEqual(expect.arrayContaining([
      moduleDependency,
      fileDependency,
    ]));
    expect(embeddedUris(custom)).not.toContain(localUri);

    const rubric = await client.readResource({ uri: localUri });
    expect("text" in rubric.contents[0] ? rubric.contents[0].text : "").toContain("Be precise.");
  });

  it("embeds the canonical agent template catalog for the create skill", async () => {
    const { client, service } = await connectWithKnowledgeModule();
    await service.addModule({
      container: "hub",
      path: "team-agents",
      name: "Team agents",
      type: "agents",
      description: "Focused team agents",
      create: true,
    });

    const result = await client.callTool({
      name: "run",
      arguments: {
        container: "hub",
        module: "team-agents",
        skill: "create",
        input: "Create a read-only code reviewer.",
      },
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(embeddedUris(result)).toContain("okh://docs/agent-templates.md");
    expect(embeddedText(result)).toContain("# Agent templates");
    expect(embeddedText(result)).toContain("`code-reviewer`");
    expect((result as CallToolResult).structuredContent).toMatchObject({
      resources: [
        expect.objectContaining({
          uri: "okh://docs/agent-templates.md",
          required: true,
          embedded: true,
        }),
      ],
      deferredRequiredUris: [],
    });
  });

  it("defers oversized required skill context to read_resource", async () => {
    const { client, root } = await connectWithKnowledgeModule();
    const skillDir = join(root, "kb", ".okh", "skills", "large-context");
    const dependencyPath = "concepts/large-context.md";
    const dependencyUri = moduleFileUri("hub", "kb", dependencyPath);
    await writeFile(
      join(root, "kb", "concepts", "large-context.md"),
      "x".repeat(MAX_EMBEDDED_RESOURCE_BYTES + 1),
    );
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: large-context\ndescription: Needs large context\nresources:\n  - ${dependencyUri}\n---\nApply the dependency.\n`,
    );

    const result = await client.callTool({
      name: "run",
      arguments: { container: "hub", module: "kb", skill: "large-context" },
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "resource_link", uri: dependencyUri }),
    ]));
    expect(embeddedUris(result)).not.toContain(dependencyUri);
    const prompt = toolContent(result)
      .filter((item) => item.type === "text")
      .map((item) => item.type === "text" ? item.text : "")
      .join("\n");
    expect(prompt).toContain(
      `read_resource { uri: ${JSON.stringify(dependencyUri)} }`,
    );
    expect((result as CallToolResult).structuredContent).toMatchObject({
      deferredRequiredUris: [dependencyUri],
    });

    const chunk = await client.callTool({
      name: "read_resource",
      arguments: { uri: dependencyUri, maxBytes: 1_024 },
    });
    expect(toolContent(chunk)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "resource",
        resource: expect.objectContaining({ uri: dependencyUri }),
      }),
    ]));
    expect((chunk as CallToolResult).structuredContent).toMatchObject({
      nextOffset: 1_024,
      totalBytes: MAX_EMBEDDED_RESOURCE_BYTES + 1,
    });
  });

  it("rejects skill dependencies the server cannot read", async () => {
    const { client, root } = await connectWithKnowledgeModule();
    const skillDir = join(root, "kb", ".okh", "skills", "external");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: external\ndescription: Unsupported external dependency\nresources:\n  - https://example.com/guide.md\n---\nDo not run.\n",
    );

    const result = await client.callTool({
      name: "run",
      arguments: { container: "hub", module: "kb", skill: "external" },
    });
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("this server cannot read"),
      }),
    ]));
    expect(result.content).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "resource_link",
        uri: "https://example.com/guide.md",
      }),
    ]));
  });

  it("rejects oversized local skill sibling resources", async () => {
    const { client, root } = await connectWithKnowledgeModule();
    const skillDir = join(root, "kb", ".okh", "skills", "oversized");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: oversized\ndescription: Oversized local dependency\n---\nRead guide.bin.\n",
    );
    const file = await open(join(skillDir, "guide.bin"), "w");
    await file.truncate(MAX_RESOURCE_FILE_BYTES + 1);
    await file.close();

    const result = await client.callTool({
      name: "run",
      arguments: { container: "hub", module: "kb", skill: "oversized" },
    });
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("cannot be read as an MCP resource"),
      }),
    ]));
    expect(result.content.some((item) => item.type === "resource_link")).toBe(false);
  });

  it("does not link local skill sibling files that cannot be opened", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const { client, root } = await connectWithKnowledgeModule();
    const skillDir = join(root, "kb", ".okh", "skills", "denied");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: denied\ndescription: Denied local dependency\n---\nRead private.md.\n",
    );
    const privatePath = join(skillDir, "private.md");
    await writeFile(privatePath, "# Private\n");
    await chmod(privatePath, 0);

    const result = await client.callTool({
      name: "run",
      arguments: { container: "hub", module: "kb", skill: "denied" },
    });
    expect(result).toMatchObject({ isError: true });
    expect(result.content.some((item) => item.type === "resource_link")).toBe(false);
  });
});
