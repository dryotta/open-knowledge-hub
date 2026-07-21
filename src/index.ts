#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolvePaths } from "./config.js";
import { ContainerService } from "./container/service.js";
import { buildServer } from "./server/index.js";
import { TodoService } from "./todos/service.js";
import { tryStartWebServer } from "./web/server.js";
import { WorkspaceService } from "./workspaces/service.js";

/**
 * Entry point: build the server and connect it over stdio (the transport every
 * MCP client uses for a locally-spawned server).
 */
async function main(): Promise<void> {
  if (process.argv[2] === "wiki") {
    const { runWikiCli } = await import("./wiki/cli.js");
    process.exit(await runWikiCli(process.argv.slice(2)));
  }
  const paths = resolvePaths();
  const service = new ContainerService(paths);
  const todoService = new TodoService(service);
  const workspaceService = new WorkspaceService(service, paths);
  const web = await tryStartWebServer({
    service,
    todos: todoService,
    workspaces: workspaceService,
  });
  try {
    const server = await buildServer({
      paths,
      service,
      todoService,
      workspaceService,
      ...(web ? { todoWebUrl: web.todosUrl } : {}),
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    if (web) await web.close();
    throw error;
  }
  if (web) {
    let webClosing = false;
    const closeWeb = (): void => {
      if (webClosing) return;
      webClosing = true;
      void web.close().catch((error: unknown) => {
        process.stderr.write(`Failed to close web UI: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    };
    process.stdin.once("end", closeWeb);
    process.stdin.once("close", closeWeb);
    process.stderr.write(`open-knowledge-hub web UI: ${web.origin}\n`);
  }
  // Log to stderr only — stdout is the JSON-RPC channel.
  process.stderr.write("open-knowledge-hub MCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
