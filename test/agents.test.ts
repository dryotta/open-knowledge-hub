import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import type { Gh } from "../src/git/gh.js";
import type { OkhPaths } from "../src/config.js";
import {
  agentsLoader,
  MAX_AGENT_PROFILE_BYTES,
  MAX_AGENT_PROMPT_CHARS,
  scanAgentProfiles,
} from "../src/modules/loaders/agents.js";
import { buildServer } from "../src/server/index.js";
import { TodoService } from "../src/todos/service.js";
import { makePaths, makeTempDir, testRun } from "./helpers.js";

class FakeGh {
  currentLoginCalls = 0;
  async currentLogin(): Promise<string> {
    this.currentLoginCalls += 1;
    return "tester";
  }
  async createRepo(): Promise<string> { return "x"; }
  async createPr(): Promise<string> { return "x"; }
}

const cleanups: string[] = [];
const servers: McpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const path = await makeTempDir("okh-agents-");
  cleanups.push(path);
  return path;
}

async function writeProfile(root: string, name: string, content: string): Promise<string> {
  const directory = join(root, ".github", "agents");
  const path = join(directory, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

async function createService(): Promise<ContainerService> {
  const home = await tempDir();
  return new ContainerService(
    makePaths(home),
    new Git(testRun),
    new FakeGh() as unknown as Gh,
  );
}

async function connect(): Promise<{
  client: Client;
  service: ContainerService;
  home: string;
  paths: OkhPaths;
  gh: FakeGh;
}> {
  const home = await tempDir();
  const paths = makePaths(home);
  const gh = new FakeGh();
  const service = new ContainerService(
    paths,
    new Git(testRun),
    gh as unknown as Gh,
  );
  const todoService = new TodoService(service);
  const server = await buildServer({ paths, service, todoService });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agents-test", version: "0" });
  servers.push(server);
  clients.push(client);
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, service, home, paths, gh };
}

function textBlocks(result: Awaited<ReturnType<Client["callTool"]>>): string[] {
  if (!("content" in result)) return [];
  return (result as CallToolResult).content
    .filter(
      (entry): entry is Extract<CallToolResult["content"][number], { type: "text" }> =>
        entry.type === "text",
    )
    .map((entry) => entry.text);
}

function isErrorResult(result: Awaited<ReturnType<Client["callTool"]>>): boolean {
  return "isError" in result && result.isError === true;
}

async function tree(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    paths.push(path);
    if (entry.isDirectory()) paths.push(...await tree(root, path));
  }
  return paths;
}

async function snapshot(root: string, relative = ""): Promise<Record<string, string>> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const result: Record<string, string> = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result[`${path}/`] = "directory";
      Object.assign(result, await snapshot(root, path));
    } else if (entry.isFile()) {
      result[path] = (await readFile(join(root, path))).toString("base64");
    } else {
      result[path] = "non-regular";
    }
  }
  return result;
}

describe("agents loader", () => {
  it("loads canonical and compatible profiles while preserving raw content and unknown frontmatter", async () => {
    const root = await tempDir();
    const canonical = [
      "---\r",
      "name: Researcher\r",
      "description: Finds primary evidence\r",
      "tools: [read, search, web]\r",
      "future-field:\r",
      "  enabled: true\r",
      "---\r",
      "\r",
      "Research the assigned question.\r",
    ].join("\n");
    const compatible = "---\ndescription: Reviews plans\nmodel: future-model\n---\n\nReview critically.\n";
    await writeProfile(root, "researcher.agent.md", canonical);
    await writeProfile(root, "reviewer.md", compatible);
    await writeProfile(root, "ignored.txt", "not a profile");

    const scan = await scanAgentProfiles(root);

    expect(scan.issues).toEqual([]);
    expect(scan.profiles.map((profile) => profile.id)).toEqual(["researcher", "reviewer"]);
    expect(scan.profiles[0]).toMatchObject({
      path: ".github/agents/researcher.agent.md",
      description: "Finds primary evidence",
      requestedTools: ["read", "search", "web"],
      frontmatter: {
        name: "Researcher",
        "future-field": { enabled: true },
      },
    });

    expect(scan.profiles[0]!.content).toBe(canonical);
    expect(scan.profiles[1]!.content).toBe(compatible);
  });

  it("preserves a UTF-8 BOM in the exact profile content", async () => {
    const root = await tempDir();
    const content = "\uFEFF---\ndescription: BOM profile\n---\n\nKeep the leading BOM.\n";
    await writeProfile(root, "bom.agent.md", content);

    const scan = await scanAgentProfiles(root);

    expect(scan.issues).toEqual([]);
    expect(scan.profiles[0]!.content).toBe(content);
    expect(scan.profiles[0]!.content.charCodeAt(0)).toBe(0xfeff);
  });

  it("rejects duplicate IDs and malformed or nested profiles without hiding valid siblings", async () => {
    const root = await tempDir();
    await writeProfile(root, "Researcher.agent.md", "---\ndescription: Canonical\n---\nPrompt.\n");
    await writeProfile(root, "researcher.md", "---\ndescription: Compatible\n---\nPrompt.\n");
    await writeProfile(root, "broken.agent.md", "---\nname: Broken\n---\nPrompt.\n");
    await writeProfile(root, "good.agent.md", "---\ndescription: Valid sibling\n---\nPrompt.\n");
    await writeProfile(root, "nested/reviewer.agent.md", "---\ndescription: Nested\n---\nPrompt.\n");

    const scan = await scanAgentProfiles(root);
    const items = await agentsLoader.enumerate(root);

    expect(scan.profiles.map((profile) => profile.id)).toEqual(["good"]);
    expect(items).toEqual([{
      path: ".github/agents/good.agent.md",
      title: "good",
      description: "Valid sibling",
      type: "agent",
    }]);
    expect(scan.issues.map((issue) => issue.message).join("\n")).toMatch(
      /duplicate agent ID "Researcher"/,
    );
    expect(scan.issues.map((issue) => issue.message).join("\n")).toMatch(
      /requires a non-empty string "description"/,
    );
    expect(scan.issues.map((issue) => issue.message).join("\n")).toMatch(
      /nested profiles are not supported/,
    );
  });

  it("enforces safe IDs, valid frontmatter, prompt length, and file size", async () => {
    const root = await tempDir();
    await writeProfile(root, "...md", "---\ndescription: Unsafe ID\n---\nPrompt.\n");
    await writeProfile(root, "yaml.agent.md", "---\ndescription: [unterminated\n---\nPrompt.\n");
    await writeProfile(
      root,
      "long.agent.md",
      `---\ndescription: Long prompt\n---\n${"x".repeat(MAX_AGENT_PROMPT_CHARS + 1)}`,
    );
    await writeProfile(
      root,
      "large.agent.md",
      `---\ndescription: Large file\n---\n${"x".repeat(MAX_AGENT_PROFILE_BYTES)}`,
    );

    const issues = (await scanAgentProfiles(root)).issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("\n");

    expect(issues).toMatch(/safe agent ID/);
    expect(issues).toMatch(/frontmatter is not valid YAML/);
    expect(issues).toMatch(/30000-character limit/);
    expect(issues).toMatch(/262144-byte file limit/);
  });

  it("counts the prompt limit in Unicode code points rather than UTF-16 units", async () => {
    const root = await tempDir();
    await writeProfile(
      root,
      "unicode.agent.md",
      `---\ndescription: Unicode prompt\n---\n${"😀".repeat(MAX_AGENT_PROMPT_CHARS)}`,
    );
    await writeProfile(
      root,
      "too-long.agent.md",
      `---\ndescription: Too long\n---\n${"😀".repeat(MAX_AGENT_PROMPT_CHARS + 1)}`,
    );

    const scan = await scanAgentProfiles(root);

    expect(scan.profiles.map((profile) => profile.id)).toEqual(["unicode"]);
    expect(scan.issues).toContainEqual(expect.objectContaining({
      path: ".github/agents/too-long.agent.md",
      message: expect.stringContaining("30000-character limit"),
    }));
  });

  it("treats a missing standard profile directory as an empty module", async () => {
    const root = await tempDir();
    expect(await scanAgentProfiles(root)).toEqual({ profiles: [], issues: [] });
    expect(await agentsLoader.validate!(root)).toEqual([]);
  });

  it("reports root-level legacy profiles without moving or hiding them", async () => {
    const root = await tempDir();
    await writeFile(
      join(root, "legacy.agent.md"),
      "---\ndescription: Legacy root profile\n---\nPrompt.\n",
    );
    await mkdir(join(root, "not-a-file.agent.md"));

    const scan = await scanAgentProfiles(root);

    expect(scan.profiles).toEqual([]);
    expect(scan.issues).toEqual([
      {
        path: "legacy.agent.md",
        message: "agent profiles must be located directly under .github/agents",
      },
      {
        path: "not-a-file.agent.md",
        message: "misplaced agent profile path must be a regular file",
      },
    ]);
    expect(await readFile(join(root, "legacy.agent.md"), "utf8")).toContain(
      "Legacy root profile",
    );
  });

  it("rejects symbolic-link profile entries", async () => {
    const root = await tempDir();
    const target = await tempDir();
    const targetProfile = await writeProfile(
      target,
      "target.agent.md",
      "---\ndescription: Outside module\n---\nPrompt.\n",
    );
    const directory = join(root, ".github", "agents");
    await mkdir(directory, { recursive: true });
    await symlink(
      process.platform === "win32" ? target : targetProfile,
      join(directory, "linked.agent.md"),
      process.platform === "win32" ? "junction" : "file",
    );

    const scan = await scanAgentProfiles(root);

    expect(scan.profiles).toEqual([]);
    expect(scan.issues).toContainEqual({
      path: ".github/agents/linked.agent.md",
      message: "symbolic links are not allowed",
    });
  });

  it("scaffolds an empty standard profile directory without granting tools", async () => {
    const root = await tempDir();

    await agentsLoader.scaffold!(root);

    const directory = join(root, ".github", "agents");
    expect(await readdir(directory)).toEqual([]);
    expect(await scanAgentProfiles(root)).toEqual({ profiles: [], issues: [] });
    await expect(agentsLoader.scaffold!(root)).resolves.toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it("survives a Git round trip when the empty profile directory is not tracked", async () => {
    const root = await tempDir();
    const cloneParent = await tempDir();
    const clone = join(cloneParent, "clone");
    await mkdir(join(root, ".okh"), { recursive: true });
    await writeFile(
      join(root, ".okh", "module.yaml"),
      "type: agents\ndescription: Empty agent library\n",
    );
    await agentsLoader.scaffold!(root);
    await testRun("git", ["init", "-b", "main"], { cwd: root });
    await testRun("git", ["add", "-A"], { cwd: root });
    await testRun("git", ["commit", "-m", "seed empty agents module"], { cwd: root });
    await testRun("git", ["clone", root, clone]);

    expect(await scanAgentProfiles(clone)).toEqual({ profiles: [], issues: [] });
    await writeProfile(
      clone,
      "reviewer.agent.md",
      "---\ndescription: Reviews code without editing\ntools: [read, search]\n---\nReview the task.\n",
    );
    expect((await scanAgentProfiles(clone)).profiles.map((profile) => profile.id)).toEqual([
      "reviewer",
    ]);
  });
});

describe("agents service integration", () => {
  it("scaffolds, inspects, validates, and resolves profiles through one shared contract", async () => {
    const source = await tempDir();
    const service = await createService();
    await service.addContainer({ source, name: "hub", create: true });
    const added = await service.addModule({
      container: "hub",
      path: "team-agents",
      type: "agents",
      description: "Research and review agents",
      create: true,
    });

    if (added.kind !== "applied") throw new Error("expected applied module");

    const custom = "---\ndescription: Finds evidence\ntools: [read, web]\nfuture: kept\n---\n\nCite sources.\n";
    await writeProfile(added.moduleRoot, "researcher.md", custom);
    await writeProfile(added.moduleRoot, "broken.agent.md", "---\nname: Broken\n---\nPrompt.\n");

    const inspected = await service.inspect("hub", "team-agents");
    if (inspected.kind !== "module") throw new Error("expected module inspect result");
    expect(inspected.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "researcher",
        description: "Finds evidence",
        path: ".github/agents/researcher.md",
      }),
    ]));
    expect(inspected.itemIssues?.join("\n")).toMatch(/broken\.agent\.md/);

    const validation = await service.validate("hub");
    expect(validation.ok).toBe(false);
    expect(validation.issues.join("\n")).toMatch(
      /agents module "team-agents".*broken\.agent\.md/,
    );

    const resolved = await service.resolveAgentProfile("hub", "team-agents", "RESEARCHER");
    expect(resolved.content).toBe(custom);
    expect(resolved.requestedTools).toEqual(["read", "web"]);
  });

  it("rejects a module root that is a symbolic link or Windows junction", async () => {
    const source = await tempDir();
    const outside = await tempDir();
    const service = await createService();
    await service.addContainer({ source, name: "hub", create: true });
    await mkdir(join(outside, ".okh"), { recursive: true });
    await writeFile(
      join(outside, ".okh", "module.yaml"),
      "type: agents\ndescription: Outside agents\n",
      "utf8",
    );
    await writeProfile(
      outside,
      "outside.agent.md",
      "---\ndescription: Outside\n---\nPrompt.\n",
    );
    await symlink(
      outside,
      join(source, "linked-agents"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      service.resolveAgentProfile("hub", "linked-agents", "outside"),
    ).rejects.toMatchObject({
      code: "INVALID_MANIFEST",
      message: expect.stringMatching(/symbolic link|junction/i),
    });
  });

  it("rejects use against a non-agents module and never treats an agent ID as a path", async () => {
    const source = await tempDir();
    const service = await createService();
    await service.addContainer({ source, name: "hub", create: true });
    await service.addModule({
      container: "hub",
      path: "kb",
      type: "knowledge",
      description: "Knowledge",
      create: true,
    });
    await service.addModule({
      container: "hub",
      path: "agents",
      type: "agents",
      description: "Agents",
      create: true,
    });

    await expect(service.resolveAgentProfile("hub", "kb", "example")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      service.resolveAgentProfile("hub", "agents", "../outside"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("use_agent MCP tool", () => {
  it("returns the exact profile and task as text-only JSON without writing runtime state", async () => {
    const source = await tempDir();
    const { client, home, paths, gh } = await connect();
    await client.callTool({
      name: "add_container",
      arguments: { source, name: "hub", create: true },
    });
    await client.callTool({
      name: "add_module",
      arguments: {
        container: "hub",
        path: "team-agents",
        type: "agents",
        description: "Team agents",
        create: true,
      },
    });
    const profile = "\uFEFF---\nname: Researcher\ndescription: Finds primary evidence\ntools: [read, search, web]\nunknown: preserved\n---\n\nCite primary sources.\n";
    const profilePath = await writeProfile(
      join(source, "team-agents"),
      "researcher.agent.md",
      profile,
    );
    const task = "Find evidence for the exact proposal.\nKeep source quotations short.";
    const beforeTree = await tree(join(source, "team-agents"));
    const beforeProfile = await readFile(profilePath, "utf8");

    const inspected = await client.callTool({
      name: "inspect",
      arguments: { container: "hub", module: "team-agents" },
    });
    expect(textBlocks(inspected).join("\n")).toContain(
      "researcher — Finds primary evidence (.github/agents/researcher.agent.md)",
    );
    const legacyRegistry = {
      version: 1,
      containers: [{
        name: "hub",
        backend: "local",
        localPath: source,
        sync: "auto",
        addedAt: "2026-07-17T00:00:00.000Z",
      }],
    };
    await writeFile(paths.registryFile, `${JSON.stringify(legacyRegistry, null, 2)}\n`, "utf8");
    const beforeHome = await snapshot(home);
    const beforeContainer = await snapshot(source);
    const beforeLoginCalls = gh.currentLoginCalls;

    const result = await client.callTool({
      name: "use_agent",
      arguments: {
        container: "hub",
        module: "team-agents",
        agent: "researcher",
        task,
      },
    });

    expect(isErrorResult(result)).toBe(false);
    expect("structuredContent" in result ? result.structuredContent : undefined).toBeUndefined();
    const blocks = textBlocks(result);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe('Prepared agent "researcher" from hub/team-agents.');
    const payload = JSON.parse(blocks[1]!) as {
      agent: Record<string, string>;
      requestedTools: string[];
      profile: { format: string; content: string };
      task: string;
      delegation: {
        preferredMode: string;
        fallbackMode: string;
        instruction: string;
      };
    };
    expect(payload).toMatchObject({
      agent: {
        container: "hub",
        module: "team-agents",
        id: "researcher",
        description: "Finds primary evidence",
      },
      requestedTools: ["read", "search", "web"],
      profile: {
        format: "github-copilot-agent-md",
        content: profile,
      },
      task,
      delegation: {
        preferredMode: "native-subagent",
        fallbackMode: "inline-parent",
      },
    });
    expect(payload.delegation.instruction).toContain("Prefer a subagent");
    expect(payload.delegation.instruction).toContain("follow the profile inline");
    expect(await snapshot(home)).toEqual(beforeHome);
    expect(await snapshot(source)).toEqual(beforeContainer);
    expect(gh.currentLoginCalls).toBe(beforeLoginCalls);
    expect(await tree(join(source, "team-agents"))).toEqual(beforeTree);
    expect(await readFile(profilePath, "utf8")).toBe(beforeProfile);
  });

  it("returns corrective errors for blank input and invalid profiles", async () => {
    const source = await tempDir();
    const { client } = await connect();
    await client.callTool({
      name: "add_container",
      arguments: { source, name: "hub", create: true },
    });
    await client.callTool({
      name: "add_module",
      arguments: {
        container: "hub",
        path: "agents",
        type: "agents",
        description: "Agents",
        create: true,
      },
    });
    await writeProfile(
      join(source, "agents"),
      "broken.agent.md",
      "---\nname: Broken\n---\nPrompt.\n",
    );

    const blankTask = await client.callTool({
      name: "use_agent",
      arguments: {
        container: "hub",
        module: "agents",
        agent: "example",
        task: " ",
      },
    });
    expect(isErrorResult(blankTask)).toBe(true);
    expect(textBlocks(blankTask).join("\n")).toContain("task cannot be empty");

    const invalid = await client.callTool({
      name: "use_agent",
      arguments: {
        container: "hub",
        module: "agents",
        agent: "broken",
        task: "Run",
      },
    });
    expect(isErrorResult(invalid)).toBe(true);
    expect(textBlocks(invalid).join("\n")).toContain("[INVALID_MANIFEST]");
  });
});
