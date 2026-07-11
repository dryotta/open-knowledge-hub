import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import {
  ListRootsRequestSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer } from "../src/server/index.js";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import type { Gh } from "../src/git/gh.js";
import { TodoService } from "../src/todos/service.js";
import { makePaths, makeTempDir, testRun } from "./helpers.js";

// ---------------------------------------------------------------------------
// Fake dependencies (mirrored from server.test.ts)
// ---------------------------------------------------------------------------

class FakeGh {
  async createRepo(): Promise<string> {
    return "x";
  }
  async createPr(): Promise<string> {
    return "x";
  }
}

// ---------------------------------------------------------------------------
// Cleanup state
// ---------------------------------------------------------------------------

const cleanups: string[] = [];
const servers: McpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

interface ConnectOptions {
  /** Client capabilities to declare before connecting. Defaults to {}. */
  capabilities?: ClientCapabilities;
  /**
   * Called after client construction (with capabilities applied) but before
   * connect(), so request handlers can be registered at the right lifecycle stage.
   */
  setupClient?: (client: Client) => void;
  /** Override the server's capability probe timeout for timeout isolation tests. */
  capabilityProbeTimeoutMs?: number;
}

async function connect(opts: ConnectOptions = {}): Promise<{ client: Client }> {
  const home = await makeTempDir();
  cleanups.push(home);
  const paths = makePaths(home);
  const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
  const todoService = new TodoService(service, () => new Date("2026-07-10T08:00:00.000Z"));
  const server = await buildServer({
    service,
    paths,
    todoService,
    ...(opts.capabilityProbeTimeoutMs !== undefined
      ? { capabilityProbeTimeoutMs: opts.capabilityProbeTimeoutMs }
      : {}),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  // Capabilities MUST be supplied to the constructor — registerCapabilities
  // cannot be called after connect, and setRequestHandler checks them.
  const client = new Client({ name: "test", version: "0" }, { capabilities: opts.capabilities ?? {} });
  if (opts.setupClient) opts.setupClient(client);
  servers.push(server);
  clients.push(client);
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return { client };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textOf(res: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!("content" in res)) return "";
  return (res as CallToolResult).content
    .filter((c): c is Extract<CallToolResult["content"][number], { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function structuredOf(res: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return (
    ("structuredContent" in res
      ? (res as { structuredContent?: Record<string, unknown> }).structuredContent
      : undefined) ?? {}
  );
}

type FeatureMap = Record<string, { status: string; message: string }>;

function featuresOf(res: Awaited<ReturnType<Client["callTool"]>>): FeatureMap {
  return (structuredOf(res).features as FeatureMap | undefined) ?? {};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("capabilities tool — all-supported client", () => {
  // Unique sentinel strings that must not appear anywhere in tool output.
  const ROOT_URI = "file:///SECRET_ROOT_URI_abcdef";
  const ROOT_NAME = "SECRET_ROOT_NAME_abcdef";
  const SAMPLING_MODEL = "secret-model-name-abcdef";
  const SAMPLED_TEXT = "SECRET_SAMPLED_TEXT_abcdef";
  const EXTENSION_SECRET = "EXTENSION_SECRET_abcdef";
  const ELICITED_HINT = "SECRET_ELICITED_HINT_abcdef";

  it("invokes probes in roots/sampling/elicitation order and reports all-passed", async () => {
    const requestOrder: string[] = [];

    const { client } = await connect({
      capabilities: {
        roots: {},
        sampling: {},
        elicitation: {},
        extensions: { "io.modelcontextprotocol/ui": { marker: EXTENSION_SECRET } },
      },
      setupClient: (c) => {
        c.setRequestHandler(ListRootsRequestSchema, async () => {
          requestOrder.push("roots");
          return { roots: [{ uri: ROOT_URI, name: ROOT_NAME }] };
        });
        c.setRequestHandler(CreateMessageRequestSchema, async () => {
          requestOrder.push("sampling");
          return {
            model: SAMPLING_MODEL,
            role: "assistant" as const,
            content: { type: "text" as const, text: SAMPLED_TEXT },
          };
        });
        c.setRequestHandler(ElicitRequestSchema, async () => {
          requestOrder.push("elicitation");
          return { action: "accept" as const, content: { hint: ELICITED_HINT } };
        });
      },
    });

    const res = await client.callTool({ name: "capabilities", arguments: {} });
    const features = featuresOf(res);

    // Probe invocation order
    expect(requestOrder).toEqual(["roots", "sampling", "elicitation"]);

    // Structured content shape: features.roots/sampling/elicitation/apps
    expect(features.roots?.status).toBe("passed");
    expect(features.sampling?.status).toBe("passed");
    expect(features.elicitation?.status).toBe("passed");
    expect(features.apps?.status).toBe("advertised");

    // Text output must not contain any handler-provided secrets
    const text = textOf(res);
    expect(text).not.toContain(ROOT_URI);
    expect(text).not.toContain(ROOT_NAME);
    expect(text).not.toContain(SAMPLING_MODEL);
    expect(text).not.toContain(SAMPLED_TEXT);
    expect(text).not.toContain(EXTENSION_SECRET);
    expect(text).not.toContain(ELICITED_HINT);

    // Structured content must not contain any handler-provided secrets either
    const structuredStr = JSON.stringify(structuredOf(res));
    expect(structuredStr).not.toContain(ROOT_URI);
    expect(structuredStr).not.toContain(ROOT_NAME);
    expect(structuredStr).not.toContain(SAMPLING_MODEL);
    expect(structuredStr).not.toContain(SAMPLED_TEXT);
    expect(structuredStr).not.toContain(EXTENSION_SECRET);
    expect(structuredStr).not.toContain(ELICITED_HINT);
  });
});

// ---------------------------------------------------------------------------

describe("capabilities tool — no-support client", () => {
  it("reports all features unsupported when no capabilities are advertised", async () => {
    // Empty capabilities => no handlers needed, no probes should fire
    const { client } = await connect({ capabilities: {} });

    const res = await client.callTool({ name: "capabilities", arguments: {} });
    const features = featuresOf(res);

    expect(features.roots?.status).toBe("unsupported");
    expect(features.sampling?.status).toBe("unsupported");
    expect(features.elicitation?.status).toBe("unsupported");
    expect(features.apps?.status).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------

describe("capabilities tool — elicitation decline and cancel via real handlers", () => {
  it("reports declined when the handler returns action:decline", async () => {
    const { client } = await connect({
      capabilities: { elicitation: {} },
      setupClient: (c) => {
        c.setRequestHandler(ElicitRequestSchema, async () => ({
          action: "decline" as const,
        }));
      },
    });

    const res = await client.callTool({ name: "capabilities", arguments: {} });
    expect(featuresOf(res).elicitation?.status).toBe("declined");
  });

  it("reports declined when the handler returns action:cancel", async () => {
    const { client } = await connect({
      capabilities: { elicitation: {} },
      setupClient: (c) => {
        c.setRequestHandler(ElicitRequestSchema, async () => ({
          action: "cancel" as const,
        }));
      },
    });

    const res = await client.callTool({ name: "capabilities", arguments: {} });
    expect(featuresOf(res).elicitation?.status).toBe("declined");
  });
});

// ---------------------------------------------------------------------------

describe("capabilities tool — failure isolation", () => {
  const ROOT_ERROR_SECRET = "ROOT_HANDLER_SECRET_ERROR_abcdef";

  it("roots failure does not block sampling; secret error detail is not echoed", async () => {
    const { client } = await connect({
      capabilities: { roots: {}, sampling: {} },
      setupClient: (c) => {
        c.setRequestHandler(ListRootsRequestSchema, async () => {
          throw new Error(ROOT_ERROR_SECRET);
        });
        c.setRequestHandler(CreateMessageRequestSchema, async () => ({
          model: "ok-model",
          role: "assistant" as const,
          content: { type: "text" as const, text: "OK" },
        }));
      },
    });

    const res = await client.callTool({ name: "capabilities", arguments: {} });
    const features = featuresOf(res);
    const text = textOf(res);

    expect(features.roots?.status).toBe("failed");
    expect(features.sampling?.status).toBe("passed");

    // The raw error detail must not appear in either the text or structured output
    expect(text).not.toContain(ROOT_ERROR_SECRET);
    expect(JSON.stringify(structuredOf(res))).not.toContain(ROOT_ERROR_SECRET);
  });
});

// ---------------------------------------------------------------------------

describe("capabilities tool — timeout isolation", () => {
  it("roots timeout does not block sampling; cleanup does not hang or emit unhandled errors", async () => {
    // Use a very short timeout so the test stays fast.
    const { client } = await connect({
      capabilities: { roots: {}, sampling: {} },
      capabilityProbeTimeoutMs: 20,
      setupClient: (c) => {
        // This handler never resolves on its own. It uses the abort signal so
        // that it cleans up promptly when the server-side request is cancelled,
        // preventing unhandled rejections after the test ends.
        c.setRequestHandler(ListRootsRequestSchema, (_req, extra) =>
          new Promise<{ roots: [] }>((_, reject) => {
            extra.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        );
        c.setRequestHandler(CreateMessageRequestSchema, async () => ({
          model: "ok-model",
          role: "assistant" as const,
          content: { type: "text" as const, text: "OK" },
        }));
      },
    });

    const res = await client.callTool({ name: "capabilities", arguments: {} });
    const features = featuresOf(res);

    expect(features.roots?.status).toBe("failed");
    expect(features.sampling?.status).toBe("passed");
  });
});

// ---------------------------------------------------------------------------

describe("capabilities tool — URL-only elicitation", () => {
  it("elicitation probe is not invoked when the client only advertises url mode", async () => {
    // No ElicitRequestSchema handler installed; if the probe fires it would
    // fail with "method not found" and the status would be "failed" not
    // "unsupported".  The correct behaviour is that the probe is skipped.
    const { client } = await connect({
      capabilities: { elicitation: { url: {} } },
    });

    const res = await client.callTool({ name: "capabilities", arguments: {} });
    expect(featuresOf(res).elicitation?.status).toBe("unsupported");
  });
});
