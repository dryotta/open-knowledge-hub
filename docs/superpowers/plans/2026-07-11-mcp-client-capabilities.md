# MCP Client Capabilities Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a zero-argument `capabilities` tool that detects and safely probes client roots, sampling, elicitation, and MCP Apps support.

**Architecture:** A focused capability module owns feature result types, fixed messages, sequential probe orchestration, and the adapter from `McpServer` to SDK requests. The existing server registration layer adds the tool using standard schema and metadata resources. Unit tests cover orchestration and failure isolation; in-memory MCP tests verify real capability negotiation and request handling.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` 1.29, Zod 4, Vitest 4, MCP in-memory transport.

---

## File Structure

- Create `src/server/capabilityProbes.ts`: capability result types, SDK request adapter, sequential probes, fixed result formatting.
- Create `test/capabilityProbes.test.ts`: focused orchestration, decline, failure, timeout, and privacy tests.
- Create `test/capabilities.test.ts`: in-memory MCP negotiation and end-to-end tool tests.
- Create `resources/tool-meta/capabilities.md`: tool title and model-facing description.
- Modify `src/server/toolSchemas.ts`: add the zero-argument tool shape.
- Modify `src/server/tools.ts`: register the capability tool.
- Modify `src/server/index.ts`: expose a probe-timeout injection point for fast timeout tests.
- Modify `test/server.test.ts`: update the exact tool surface assertion.
- Modify `README.md`: document the diagnostic tool and its interactive probes.

### Task 1: Build the Sequential Probe Engine

**Files:**
- Create: `src/server/capabilityProbes.ts`
- Create: `test/capabilityProbes.test.ts`

- [ ] **Step 1: Write failing probe orchestration tests**

Create `test/capabilityProbes.test.ts` with a small fake implementing exported `CapabilityProbeOperations`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  runCapabilityProbes,
  type CapabilityProbeOperations,
} from "../src/server/capabilityProbes.js";

function operations(overrides: Partial<CapabilityProbeOperations> = {}): CapabilityProbeOperations {
  return {
    capabilities: () => ({}),
    roots: vi.fn(async () => undefined),
    sampling: vi.fn(async () => undefined),
    elicitation: vi.fn(async () => "accept"),
    ...overrides,
  };
}

describe("runCapabilityProbes", () => {
  it("does not call unsupported core features", async () => {
    const ops = operations();
    const report = await runCapabilityProbes(ops);

    expect(report.features).toEqual({
      roots: { available: false, status: "unsupported", message: "Roots are not advertised." },
      sampling: { available: false, status: "unsupported", message: "Sampling is not advertised." },
      elicitation: { available: false, status: "unsupported", message: "Elicitation is not advertised." },
      apps: { available: false, status: "unsupported", message: "MCP Apps is not advertised." },
    });
    expect(ops.roots).not.toHaveBeenCalled();
    expect(ops.sampling).not.toHaveBeenCalled();
    expect(ops.elicitation).not.toHaveBeenCalled();
  });

  it("probes advertised core features sequentially", async () => {
    const order: string[] = [];
    const ops = operations({
      capabilities: () => ({
        roots: {},
        sampling: {},
        elicitation: {},
        extensions: { "io.modelcontextprotocol/ui": {} },
      }),
      roots: vi.fn(async () => { order.push("roots"); }),
      sampling: vi.fn(async () => { order.push("sampling"); }),
      elicitation: vi.fn(async () => { order.push("elicitation"); return "accept"; }),
    });

    const report = await runCapabilityProbes(ops);

    expect(order).toEqual(["roots", "sampling", "elicitation"]);
    expect(report.features.roots.status).toBe("passed");
    expect(report.features.sampling.status).toBe("passed");
    expect(report.features.elicitation.status).toBe("passed");
    expect(report.features.apps.status).toBe("advertised");
  });

  it.each(["decline", "cancel"] as const)("reports elicitation %s as declined", async (action) => {
    const report = await runCapabilityProbes(operations({
      capabilities: () => ({ elicitation: {} }),
      elicitation: vi.fn(async () => action),
    }));

    expect(report.features.elicitation).toEqual({
      available: true,
      status: "declined",
      message: "Elicitation was declined or cancelled.",
    });
  });

  it("records a failed probe and continues", async () => {
    const sampling = vi.fn(async () => undefined);
    const report = await runCapabilityProbes(operations({
      capabilities: () => ({ roots: {}, sampling: {} }),
      roots: vi.fn(async () => { throw new Error("ROOT_SECRET"); }),
      sampling,
    }));

    expect(report.features.roots.status).toBe("failed");
    expect(report.features.roots.message).toBe("Roots request failed.");
    expect(report.features.sampling.status).toBe("passed");
    expect(sampling).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain("ROOT_SECRET");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test\capabilityProbes.test.ts`

Expected: FAIL because `src/server/capabilityProbes.ts` does not exist.

- [ ] **Step 3: Implement result types and sequential orchestration**

Create `src/server/capabilityProbes.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";
export const DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS = 60_000;

export type CapabilityStatus = "unsupported" | "passed" | "declined" | "failed" | "advertised";

export interface CapabilityFeatureResult {
  available: boolean;
  status: CapabilityStatus;
  message: string;
}

export interface CapabilityReport {
  features: {
    roots: CapabilityFeatureResult;
    sampling: CapabilityFeatureResult;
    elicitation: CapabilityFeatureResult;
    apps: CapabilityFeatureResult;
  };
}

export interface CapabilityProbeOperations {
  capabilities(): ClientCapabilities | undefined;
  roots(): Promise<void>;
  sampling(): Promise<void>;
  elicitation(): Promise<"accept" | "decline" | "cancel">;
}

const unsupported = (message: string): CapabilityFeatureResult => ({
  available: false,
  status: "unsupported",
  message,
});

async function probe(
  operation: () => Promise<void>,
  successMessage: string,
  failureMessage: string,
): Promise<CapabilityFeatureResult> {
  try {
    await operation();
    return { available: true, status: "passed", message: successMessage };
  } catch {
    return { available: true, status: "failed", message: failureMessage };
  }
}

function supportsFormElicitation(capability: ClientCapabilities["elicitation"]): boolean {
  if (capability === undefined) return false;
  const hasDeclaredModes = capability.form !== undefined || capability.url !== undefined;
  return !hasDeclaredModes || capability.form !== undefined;
}

export async function runCapabilityProbes(ops: CapabilityProbeOperations): Promise<CapabilityReport> {
  const capabilities = ops.capabilities();

  const roots = capabilities?.roots === undefined
    ? unsupported("Roots are not advertised.")
    : await probe(ops.roots, "Roots request succeeded.", "Roots request failed.");

  const sampling = capabilities?.sampling === undefined
    ? unsupported("Sampling is not advertised.")
    : await probe(ops.sampling, "Sampling request succeeded.", "Sampling request failed.");

  let elicitation: CapabilityFeatureResult;
  if (!supportsFormElicitation(capabilities?.elicitation)) {
    elicitation = unsupported("Form elicitation is not advertised.");
  } else {
    try {
      const action = await ops.elicitation();
      elicitation = action === "accept"
        ? { available: true, status: "passed", message: "Elicitation request succeeded." }
        : { available: true, status: "declined", message: "Elicitation was declined or cancelled." };
    } catch {
      elicitation = { available: true, status: "failed", message: "Elicitation request failed." };
    }
  }

  const appsAdvertised =
    capabilities?.extensions !== undefined &&
    Object.hasOwn(capabilities.extensions, MCP_APPS_EXTENSION);
  const apps: CapabilityFeatureResult = appsAdvertised
    ? { available: true, status: "advertised", message: "MCP Apps extension is advertised." }
    : unsupported("MCP Apps is not advertised.");

  return { features: { roots, sampling, elicitation, apps } };
}

export function createCapabilityProbeOperations(
  server: McpServer,
  timeoutMs = DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS,
): CapabilityProbeOperations {
  const options = { timeout: timeoutMs };
  return {
    capabilities: () => server.server.getClientCapabilities(),
    roots: async () => {
      await server.server.listRoots(undefined, options);
    },
    sampling: async () => {
      await server.server.createMessage({
        messages: [{
          role: "user",
          content: { type: "text", text: "Confirm that MCP sampling is available." },
        }],
        maxTokens: 16,
      }, options);
    },
    elicitation: async () => {
      const result = await server.server.elicitInput({
        mode: "form",
        message: "Confirm that MCP elicitation is available.",
        requestedSchema: {
          type: "object",
          properties: {
            confirmed: { type: "boolean", title: "Confirm capability test" },
          },
          required: ["confirmed"],
        },
      }, options);
      return result.action;
    },
  };
}

export function formatCapabilityReport(report: CapabilityReport): string {
  return Object.entries(report.features)
    .map(([name, result]) => `- ${name}: ${result.status} — ${result.message}`)
    .join("\n");
}
```

- [ ] **Step 4: Run the focused test**

Run: `npx vitest run test\capabilityProbes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the probe engine**

```powershell
git add src\server\capabilityProbes.ts test\capabilityProbes.test.ts
git commit -m "feat: add MCP capability probe engine" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: c9e9137c-e832-4720-8513-650bdd1acde1"
```

### Task 2: Register the `capabilities` Tool

**Files:**
- Create: `resources/tool-meta/capabilities.md`
- Modify: `src/server/toolSchemas.ts`
- Modify: `src/server/tools.ts`
- Modify: `src/server/index.ts`
- Modify: `test/server.test.ts`
- Test: `test/toolMeta.test.ts`

- [ ] **Step 1: Update the exact tool surface test first**

In `test/server.test.ts`, rename the test to `exposes exactly the 11 tools and no prompts` and add `"capabilities"` to the sorted expected list between `"ask"` and `"config"`.

- [ ] **Step 2: Run the surface test to verify it fails**

Run: `npx vitest run test\server.test.ts -t "exposes exactly"`

Expected: FAIL because `capabilities` is missing.

- [ ] **Step 3: Add the schema and metadata resource**

Add to `toolShapes` in `src/server/toolSchemas.ts`:

```ts
capabilities: {},
```

Create `resources/tool-meta/capabilities.md`:

```md
---
title: Check MCP client capabilities
---
Check whether the connected MCP client advertises roots, sampling, form elicitation, and MCP Apps. Every advertised core feature is tested immediately; sampling may use the client's model and elicitation may display a confirmation prompt.
```

- [ ] **Step 4: Add registration with injectable timeout**

Extend `BuildServerOptions` in `src/server/index.ts`:

```ts
capabilityProbeTimeoutMs?: number;
```

Pass it to `registerTools`:

```ts
await registerTools(server, service, paths, todoService, {
  capabilityProbeTimeoutMs: options.capabilityProbeTimeoutMs,
});
```

In `src/server/tools.ts`, import the capability helpers:

```ts
import {
  createCapabilityProbeOperations,
  formatCapabilityReport,
  runCapabilityProbes,
} from "./capabilityProbes.js";
```

Add an options type and optional parameter:

```ts
interface RegisterToolsOptions {
  capabilityProbeTimeoutMs?: number;
}

export async function registerTools(
  server: McpServer,
  service: ContainerService,
  paths: OkhPaths,
  todoService: TodoService,
  options: RegisterToolsOptions = {},
): Promise<void> {
```

Register the tool before `onboard`:

```ts
server.registerTool(
  "capabilities",
  { ...(await toolReg("capabilities")), annotations: { readOnlyHint: true, openWorldHint: false } },
  handler(async () => {
    const operations = createCapabilityProbeOperations(server, options.capabilityProbeTimeoutMs);
    const report = await runCapabilityProbes(operations);
    return ok(formatCapabilityReport(report), { features: report.features });
  }),
);
```

Adjust `createCapabilityProbeOperations` so `undefined` selects the default:

```ts
export function createCapabilityProbeOperations(
  server: McpServer,
  timeoutMs = DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS,
): CapabilityProbeOperations {
```

When passing the optional field, preserve `exactOptionalPropertyTypes`:

```ts
await registerTools(server, service, paths, todoService, {
  ...(options.capabilityProbeTimeoutMs !== undefined
    ? { capabilityProbeTimeoutMs: options.capabilityProbeTimeoutMs }
    : {}),
});
```

- [ ] **Step 5: Run metadata and surface tests**

Run: `npx vitest run test\toolMeta.test.ts test\server.test.ts -t "exposes exactly|every tool has complete"`

Expected: PASS.

- [ ] **Step 6: Commit tool registration**

```powershell
git add resources\tool-meta\capabilities.md src\server\toolSchemas.ts src\server\tools.ts src\server\index.ts test\server.test.ts
git commit -m "feat: register MCP capabilities tool" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: c9e9137c-e832-4720-8513-650bdd1acde1"
```

### Task 3: Verify Real Client Negotiation and Requests

**Files:**
- Create: `test/capabilities.test.ts`
- Modify: `src/server/capabilityProbes.ts` only if the protocol tests expose a type or behavior defect.

- [ ] **Step 1: Add an in-memory connection helper**

Create `test/capabilities.test.ts` with imports and cleanup matching `test/server.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer } from "../src/server/index.js";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { TodoService } from "../src/todos/service.js";
import { makePaths, makeTempDir, testRun } from "./helpers.js";

class FakeGh {
  async createRepo(): Promise<string> { return "x"; }
  async createPr(): Promise<string> { return "x"; }
}

const servers: McpServer[] = [];
const clients: Client[] = [];
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

interface ConnectOptions {
  capabilities?: ClientCapabilities;
  capabilityProbeTimeoutMs?: number;
  setupClient?: (client: Client) => void;
}

async function connect(options: ConnectOptions = {}): Promise<Client> {
  const home = await makeTempDir();
  homes.push(home);
  const paths = makePaths(home);
  const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
  const todoService = new TodoService(service);
  const server = await buildServer({
    service,
    paths,
    todoService,
    ...(options.capabilityProbeTimeoutMs !== undefined
      ? { capabilityProbeTimeoutMs: options.capabilityProbeTimeoutMs }
      : {}),
  });
  const client = new Client(
    { name: "capability-test", version: "1" },
    { capabilities: options.capabilities ?? {} },
  );
  options.setupClient?.(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  servers.push(server);
  clients.push(client);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function structuredOf(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return ("structuredContent" in result
    ? (result as { structuredContent?: Record<string, unknown> }).structuredContent
    : undefined) ?? {};
}
```

- [ ] **Step 2: Add all-supported and privacy-safe coverage**

Add:

```ts
it("tests every advertised feature without exposing observed values", async () => {
  const calls: string[] = [];
  const client = await connect({
    capabilities: {
      roots: {},
      sampling: {},
      elicitation: {},
      extensions: { "io.modelcontextprotocol/ui": { marker: "EXTENSION_SECRET" } },
    },
    setupClient: (client) => {
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        calls.push("roots");
        return { roots: [{ uri: "file:///ROOT_SECRET", name: "ROOT_NAME_SECRET" }] };
      });
      client.setRequestHandler(CreateMessageRequestSchema, async () => {
        calls.push("sampling");
        return {
          model: "MODEL_SECRET",
          role: "assistant",
          content: { type: "text", text: "SAMPLED_SECRET" },
        };
      });
      client.setRequestHandler(ElicitRequestSchema, async () => {
        calls.push("elicitation");
        return { action: "accept", content: { confirmed: true } };
      });
    },
  });

  const result = await client.callTool({ name: "capabilities", arguments: {} });
  const serialized = JSON.stringify(result);

  expect(calls).toEqual(["roots", "sampling", "elicitation"]);
  expect(structuredOf(result)).toMatchObject({
    features: {
      roots: { available: true, status: "passed" },
      sampling: { available: true, status: "passed" },
      elicitation: { available: true, status: "passed" },
      apps: { available: true, status: "advertised" },
    },
  });
  for (const secret of [
    "ROOT_SECRET",
    "ROOT_NAME_SECRET",
    "MODEL_SECRET",
    "SAMPLED_SECRET",
    "EXTENSION_SECRET",
  ]) {
    expect(serialized).not.toContain(secret);
  }
});
```

- [ ] **Step 3: Add partial support, decline, failure, and timeout coverage**

Add tests that:

1. connect with `{ capabilities: {} }` and assert all statuses are `unsupported`;
2. return `{ action: "decline" }` and assert elicitation is `declined`;
3. throw `new Error("CLIENT_ERROR_SECRET")` from roots, return valid sampling, and assert roots is `failed`, sampling is `passed`, and the secret is absent;
4. return a never-resolving promise from roots with `capabilityProbeTimeoutMs: 10`, return valid sampling, and assert roots is `failed` and sampling still runs.

Use this timeout handler:

```ts
client.setRequestHandler(ListRootsRequestSchema, async () => {
  await new Promise<never>(() => undefined);
});
```

Use a sampling handler identical to the valid response in Step 2 so the test proves later probes continue.

- [ ] **Step 4: Run the capability tests**

Run: `npx vitest run test\capabilityProbes.test.ts test\capabilities.test.ts test\server.test.ts test\toolMeta.test.ts`

Expected: PASS with no unhandled request or timeout errors.

- [ ] **Step 5: Commit protocol coverage**

```powershell
git add test\capabilities.test.ts src\server\capabilityProbes.ts
git commit -m "test: verify MCP client capability probes" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: c9e9137c-e832-4720-8513-650bdd1acde1"
```

### Task 4: Document and Validate the Tool

**Files:**
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Update user-facing documentation**

In `README.md`:

- add `capabilities` to the operational/diagnostic surface introduction;
- add this row to the tool table:

```md
| `capabilities` | _(none)_ | Detect and immediately test advertised client roots, sampling, and form elicitation support; report MCP Apps extension negotiation. |
```

- add a short warning below the table:

```md
`capabilities` is diagnostic and interactive: an advertised sampling capability triggers a small client-model request, and advertised form elicitation displays a confirmation prompt. Probe output never includes returned roots, sampled content, elicited values, extension configuration, or raw client errors.
```

In `package.json`, replace the stale counted description with:

```json
"description": "An MCP server that organizes agent knowledge and capabilities into containers of typed modules, with deterministic tools, guided flows, todos, and client capability diagnostics.",
```

- [ ] **Step 2: Run focused tests and type checks**

Run: `npx vitest run test\capabilityProbes.test.ts test\capabilities.test.ts test\server.test.ts test\toolMeta.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit code 0.

Run: `npm run build`

Expected: exit code 0.

- [ ] **Step 3: Run the non-eval regression suite**

Run: `npm test`

Expected: all Vitest tests pass.

- [ ] **Step 4: Run the existing e2e eval at PR-ready completion**

Run: `npm run eval`

Expected: the existing e2e eval passes. Do not add a capability-specific eval scenario; this run is final regression validation only, after implementation and non-eval validation are complete.

- [ ] **Step 5: Verify the package contents**

Run: `npm pack --dry-run`

Expected: exit code 0; output includes `dist\server\capabilityProbes.js` and `resources\tool-meta\capabilities.md`.

- [ ] **Step 6: Commit documentation**

```powershell
git add README.md package.json
git commit -m "docs: document client capability diagnostics" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: c9e9137c-e832-4720-8513-650bdd1acde1"
```
