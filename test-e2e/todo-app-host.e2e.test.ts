import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

// End-to-end regression test for the todo MCP App.
//
// This exercises the *compiled* app bundle in real Chromium, embedded in an
// <iframe> exactly like an MCP Apps host would. jsdom cannot run the bundle's
// `<script type="module">`, so this is the only layer that proves the click ->
// callServerTool flow, the capability gate, and the update timeout end to end.

const BUNDLE_PATH = fileURLToPath(new URL("../dist/apps/todos.html", import.meta.url));

const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<iframe id="app" src="/app" style="width:900px;height:700px;border:0"></iframe>
<script>
const cfg = new URLSearchParams(location.search);
const serverTools = cfg.get("serverTools") === "1";
const mode = cfg.get("mode") || "respond"; // respond | timeout
window.__hostlog = [];
const iframe = document.getElementById("app");
const TASK = {
  ref: "alpha/memory#1", status: "open", statusChar: " ", readOnly: false,
  text: "Write the report", labels: ["work"], priority: "high", due: "2026-07-15",
  warnings: [], source: { container: "alpha", module: "memory", path: "2026-07-11.md", line: 3 },
};
function post(msg){ iframe.contentWindow.postMessage(msg, "*"); }
function toolResult(){
  post({ jsonrpc:"2.0", method:"ui/notifications/tool-result", params:{
    content:[{type:"text",text:"Todos: 1 open"}],
    structuredContent:{ operation:"list", tasks:[TASK], warnings:[], counts:{total:1,open:1,completed:0,custom:0} }
  }});
}
window.addEventListener("message", (ev) => {
  if (ev.source !== iframe.contentWindow) return;
  const msg = ev.data;
  if (!msg || msg.jsonrpc !== "2.0") return;
  window.__hostlog.push({ method: msg.method, id: msg.id ?? null });
  if (msg.method === "ui/initialize") {
    post({ jsonrpc:"2.0", id: msg.id, result:{
      protocolVersion:"2026-01-26",
      hostInfo:{ name:"PlaywrightHost", version:"1.0.0" },
      hostCapabilities: serverTools ? { serverTools:{} } : {},
      hostContext:{},
    }});
    setTimeout(toolResult, 40);
    return;
  }
  if (msg.method === "tools/call") {
    if (mode === "timeout") return; // never respond -> exercise the update timeout
    const completed = { ...TASK, status:"completed", statusChar:"x", completed:"2026-07-11" };
    post({ jsonrpc:"2.0", id: msg.id, result:{
      content:[{type:"text",text:"Marked todo completed"}],
      structuredContent:{ operation:"update", applied:true, todo:completed, dirtyContainer:"alpha" }
    }});
    return;
  }
});
</script></body></html>`;

let browser: Browser;
let server: Server;
let base: string;

beforeAll(async () => {
  const bundle = await readFile(BUNDLE_PATH, "utf8");
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url === "/app" ? bundle : HOST_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://localhost:${port}`;
  browser = await chromium.launch();
}, 60000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function openApp(query: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${base}/?${query}`);
  const app = page.frameLocator("#app");
  await app
    .locator("input.todo-check, #updates-banner:not([hidden])")
    .first()
    .waitFor({ timeout: 10000 });
  return page;
}

describe("todo app end-to-end (real browser host)", () => {
  it("applies the update when the host can proxy server tools", async () => {
    const page = await openApp("serverTools=1&mode=respond");
    const app = page.frameLocator("#app");
    const checkbox = app.locator("input.todo-check").first();

    expect(await checkbox.isDisabled()).toBe(false);
    expect(await app.locator("#updates-banner").evaluate((el: HTMLElement) => el.hidden)).toBe(true);

    await checkbox.click();
    await page.waitForFunction(
      () =>
        (window as unknown as { __hostlog: { method: string }[] }).__hostlog.some(
          (m) => m.method === "tools/call",
        ),
      undefined,
      { timeout: 5000 },
    );

    await app.locator(".todo-row.completed").first().waitFor({ timeout: 5000 });
    expect(await app.locator("#error-banner").evaluate((el: HTMLElement) => el.hidden)).toBe(true);
    await page.close();
  });

  it("disables checkboxes and shows a notice when the host cannot proxy updates", async () => {
    const page = await openApp("serverTools=0&mode=respond");
    const app = page.frameLocator("#app");
    const checkbox = app.locator("input.todo-check").first();

    expect(await checkbox.isDisabled()).toBe(true);
    const banner = app.locator("#updates-banner");
    expect(await banner.evaluate((el: HTMLElement) => el.hidden)).toBe(false);
    expect((await banner.textContent())?.trim().length).toBeGreaterThan(0);
    await page.close();
  });

  it("surfaces an error instead of hanging when the host never responds", async () => {
    const page = await openApp("serverTools=1&mode=timeout");
    const app = page.frameLocator("#app");
    await app.locator("input.todo-check").first().click();

    const errorBanner = app.locator("#error-banner");
    await app.locator("#error-banner:not([hidden])").first().waitFor({ timeout: 8000 });
    expect((await errorBanner.textContent())?.toLowerCase()).toContain("could not update");
    await page.close();
  });
});
