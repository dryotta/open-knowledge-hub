import vm from "node:vm";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const RUN_ID = "0123456789abcdef0123456789abcdef";

type RpcMessage = {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

async function loadAppScript(): Promise<string> {
  const html = await readFile(new URL("../resources/apps/capabilities.html", import.meta.url), "utf8");
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("capabilities.html has no inline <script>");
  return match[1];
}

type AppHarness = {
  outgoing: RpcMessage[];
  win: { innerWidth: number; innerHeight: number };
  deliver: (message: RpcMessage) => void;
};

function startApp(script: string, hostContext: Record<string, unknown>): AppHarness {
  const outgoing: RpcMessage[] = [];
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const host: { postMessage: (message: RpcMessage) => void } = { postMessage: () => {} };

  const win = {
    innerWidth: 200,
    innerHeight: 200,
    parent: host,
    addEventListener(type: string, fn: (event: { source: unknown; data: unknown }) => void): void {
      if (type === "message") listeners.push(fn);
    },
  };

  function deliver(message: RpcMessage): void {
    for (const fn of listeners) fn({ source: host, data: message });
  }
  function queueDeliver(message: RpcMessage): void {
    void Promise.resolve().then(() => deliver(message));
  }

  host.postMessage = (message: RpcMessage): void => {
    outgoing.push(message);
    if (message.method === "ui/initialize" && typeof message.id === "number") {
      queueDeliver({ jsonrpc: "2.0", id: message.id, result: { hostContext } });
    } else if (message.method === "tools/call" && typeof message.id === "number") {
      queueDeliver({ jsonrpc: "2.0", id: message.id, result: { content: [], structuredContent: {} } });
    }
  };

  const document = {
    getElementById: () => ({ style: {} as Record<string, string>, textContent: "" }),
    documentElement: { scrollWidth: 320, scrollHeight: 320 },
  };

  const context: Record<string, unknown> = {
    window: win,
    document,
    setTimeout,
    clearTimeout,
    Promise,
    Map,
    JSON,
    Object,
    Array,
    Error,
    String,
    Boolean,
    Number,
    console,
  };
  vm.createContext(context);
  vm.runInContext(script, context);

  return { outgoing, win, deliver };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const settleResize = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

function toolResult(): RpcMessage {
  return {
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { content: [], structuredContent: { runId: RUN_ID } },
  };
}

function reportedResize(harness: AppHarness): string | undefined {
  const call = harness.outgoing.find(
    (message) =>
      message.method === "tools/call" &&
      (message.params?.arguments as { action?: string } | undefined)?.action === "app_report",
  );
  const app = (call?.params?.arguments as { app?: { resize?: string } } | undefined)?.app;
  return app?.resize;
}

describe("capabilities MCP App resize probe", () => {
  it("reports observed when a viewport change lands before the tool result arrives", async () => {
    const app = startApp(await loadAppScript(), {});
    await flush();

    // Host delivers the tool result before the resize window closes.
    app.deliver(toolResult());
    app.win.innerHeight = 520;

    await settleResize();
    expect(reportedResize(app)).toBe("observed");
  });

  it("prefers an observed change over a declared fixed container", async () => {
    const app = startApp(await loadAppScript(), { containerDimensions: { width: 400 } });
    await flush();

    app.win.innerHeight = 520;
    await settleResize();
    app.deliver(toolResult());
    await flush();

    expect(reportedResize(app)).toBe("observed");
  });

  it("reports fixed_container when nothing resizes but a fixed container is declared", async () => {
    const app = startApp(await loadAppScript(), { containerDimensions: { width: 400 } });
    await flush();

    await settleResize();
    app.deliver(toolResult());
    await flush();

    expect(reportedResize(app)).toBe("fixed_container");
  });

  it("reports unobserved when nothing resizes and no fixed container is declared", async () => {
    const app = startApp(await loadAppScript(), {});
    await flush();

    await settleResize();
    app.deliver(toolResult());
    await flush();

    expect(reportedResize(app)).toBe("unobserved");
  });
});
