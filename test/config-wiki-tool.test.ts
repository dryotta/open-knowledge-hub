import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { buildServer } from "../src/server/index.js";
import { saveRegistry } from "../src/registry/registry.js";
import { makePaths, makeTempDir, testRun } from "./helpers.js";

class FakeGh { async currentLogin(): Promise<string> { return "tester"; } }

const cleanups: string[] = [];
async function connect() {
  const home = await makeTempDir(); cleanups.push(home);
  const paths = makePaths(home);
  const clone = await makeTempDir(); cleanups.push(clone);
  await saveRegistry(paths, {
    version: 2,
    containers: [{
      name: "widgets",
      backend: { type: "git", config: { origin: "https://github.com/acme/widgets.git" } },
      localPath: clone,
      sync: { mode: "auto", config: {} },
      addedAt: new Date().toISOString(),
    }],
  });
  const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
  const server = await buildServer({ paths, service });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client };
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const text = (r: any) => r.content.map((c: any) => c.text).join("");

describe("config tool container scope", () => {
  it("views wiki.enabled=false by default", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "config", arguments: { container: "widgets" } });
    expect(text(r)).toContain("wiki.enabled: false");
  });

  it("enables wiki via set", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "config", arguments: { container: "widgets", set: { wiki: { enabled: true } } } });
    expect(r.isError).toBeFalsy();
    expect(text(r).toLowerCase()).toContain("sync");
    const v = await client.callTool({ name: "config", arguments: { container: "widgets" } });
    expect(text(v)).toContain("wiki.enabled: true");
  });

  it("rejects an unknown container-scope key", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "config", arguments: { container: "widgets", set: { bogus: 1 } } });
    expect(r.isError).toBeTruthy();
  });
});
