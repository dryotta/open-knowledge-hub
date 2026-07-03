import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  ContainerService,
  InspectResult,
  SyncResult,
} from "../container/service.js";
import { isOkhError } from "../errors.js";
import { moduleTypeSchema } from "../modules/types.js";
import { buildAsk, buildContext, buildLearn, buildReflect, buildRemember } from "../prompts/index.js";

function ok(text: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}

function fail(message: string, hint?: string): CallToolResult {
  return { content: [{ type: "text", text: hint ? `${message}\n\nHint: ${hint}` : message }], isError: true };
}

function handler<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      if (isOkhError(err)) return fail(`[${err.code}] ${err.message}`, err.hint);
      throw err;
    }
  };
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function formatInspect(r: InspectResult): string {
  if (r.kind === "containers") {
    if (r.containers.length === 0) return "No containers registered. Use add { source } to register one.";
    return r.containers
      .map(
        (c) =>
          `- ${c.name} [${c.backend}] sync=${c.sync ?? "?"} modules=${c.moduleCount}` +
          `${c.manifestValid ? "" : " (invalid manifest)"} — ${c.localPath}`,
      )
      .join("\n");
  }
  if (r.kind === "container") {
    const s = r.status;
    const lines = [
      `Container: ${s.name} [${s.backend}]`,
      `Sync: ${s.sync ?? "?"}`,
      `Path: ${s.localPath}`,
      `Manifest valid: ${s.manifestValid}${s.manifestError ? ` (${s.manifestError})` : ""}`,
      "Modules:",
      ...(s.modules.length
        ? s.modules.map((m) => `  - ${m.type}: ${m.path} (${m.items} items)`)
        : ["  (none)"]),
    ];
    if (s.git) {
      lines.push(
        `Git: branch=${s.git.branch} dirty=${s.git.dirty} ahead/behind=${s.git.ahead}/${s.git.behind} unpushed=${s.git.hasUnpushedCommits}`,
      );
    }
    return lines.join("\n");
  }
  const head = `Module ${r.module.path} [${r.module.type}] — ${r.items.length} items`;
  const items = r.items.length
    ? r.items.map((i) => `  - ${i.title}${i.description ? ` — ${i.description}` : ""} (${i.path})`)
    : ["  (empty)"];
  return [head, ...items].join("\n");
}

function formatSync(rs: SyncResult[]): string {
  if (rs.length === 0) return "Nothing to sync.";
  return rs
    .map((r) => {
      const v = r.validation.ok ? "valid" : `INVALID: ${r.validation.issues.join("; ")}`;
      const extra = r.prUrl ? ` PR: ${r.prUrl}` : "";
      return `- ${r.name} [${r.backend}] ${r.action} (${v})${extra}`;
    })
    .join("\n");
}

/** Register the three operational tools + five cognitive prompt-tools. */
export function registerTools(server: McpServer, service: ContainerService): void {
  server.registerTool(
    "inspect",
    {
      title: "Inspect containers/modules",
      description:
        "List registered containers (no args), a container's modules + status (container), or a module's items (container + module).",
      inputSchema: {
        container: z.string().optional().describe("Container name to inspect."),
        module: z.string().optional().describe("Module path within the container."),
      },
    },
    handler(async (args: { container?: string; module?: string }) => {
      if (args.module !== undefined && args.container === undefined) {
        return fail("Inspecting a module requires { container, module }.");
      }
      if (args.container !== undefined && isBlank(args.container)) return fail("container cannot be empty.");
      if (args.module !== undefined && isBlank(args.module)) return fail("module cannot be empty.");
      const result = await service.inspect(args.container, args.module);
      return ok(formatInspect(result), { result });
    }),
  );

  server.registerTool(
    "add",
    {
      title: "Add a container or module",
      description:
        "Add a container with { source, name?, sync?, backend? } (source is a git URL or a local/OneDrive path), " +
        "or add a module with { container, path, type, config? }.",
      inputSchema: {
        source: z.string().optional().describe("Git URL or local/OneDrive path (new container)."),
        name: z.string().optional().describe("Container name (defaults to the source basename)."),
        sync: z.enum(["auto", "pr"]).optional().describe("Git write mode for a new container."),
        backend: z.enum(["local", "onedrive"]).optional().describe("Label a path source as local or onedrive."),
        container: z.string().optional().describe("Target container (new module)."),
        path: z.string().optional().describe("Module folder path within the container (new module)."),
        type: moduleTypeSchema.optional().describe("Module type (new module)."),
        config: z.record(z.string(), z.unknown()).optional().describe("Optional module config."),
      },
    },
    handler(
      async (args: {
        source?: string;
        name?: string;
        sync?: "auto" | "pr";
        backend?: "local" | "onedrive";
        container?: string;
        path?: string;
        type?: "knowledge" | "skills" | "tools" | "memory" | "project";
        config?: Record<string, unknown>;
      }) => {
        const hasSource = args.source !== undefined;
        const hasModuleFields =
          args.container !== undefined || args.path !== undefined || args.type !== undefined || args.config !== undefined;
        if (hasSource && hasModuleFields) {
          return fail("add requires either { source } or { container, path, type }, not both.");
        }
        if (args.source !== undefined) {
          if (isBlank(args.source)) return fail("source cannot be empty.");
          const entry = await service.addContainer({
            source: args.source,
            ...(args.name ? { name: args.name } : {}),
            ...(args.sync ? { sync: args.sync } : {}),
            ...(args.backend ? { backend: args.backend } : {}),
          });
          return ok(`Registered container "${entry.name}" [${entry.backend}] at ${entry.localPath}.`, { entry });
        }
        if (hasModuleFields) {
          if (args.container === undefined || args.path === undefined || args.type === undefined) {
            return fail("Adding a module requires { container, path, type }.");
          }
          if (isBlank(args.container)) return fail("container cannot be empty.");
          if (isBlank(args.path)) return fail("path cannot be empty.");
          const { entry, moduleRoot } = await service.addModule({
            container: args.container,
            path: args.path,
            type: args.type,
            ...(args.config ? { config: args.config } : {}),
          });
          return ok(`Added ${entry.type} module "${entry.path}" to "${args.container}" at ${moduleRoot}.`, { entry });
        }
        return fail("add requires either { source } (new container) or { container, path, type } (new module).");
      },
    ),
  );

  server.registerTool(
    "sync",
    {
      title: "Sync containers",
      description:
        "Validate and synchronize a container (or all containers). Git containers commit+push (auto) or open a PR (pr).",
      inputSchema: {
        container: z.string().optional().describe("Container to sync (default: all)."),
        message: z.string().optional().describe("Commit/PR message."),
      },
    },
    handler(async (args: { container?: string; message?: string }) => {
      if (args.container !== undefined && isBlank(args.container)) return fail("container cannot be empty.");
      const results = await service.sync(args.container, args.message);
      return ok(formatSync(results), { results });
    }),
  );

  registerCognitiveTools(server, service);
}

const promptArgs = {
  container: z.string().optional().describe("Container name (default: all registered containers)."),
  module: z.string().optional().describe("Module path within the container."),
};

/** The five cognitive prompts, also exposed as tools for clients without prompt support. */
function registerCognitiveTools(server: McpServer, service: ContainerService): void {
  server.registerTool(
    "ask",
    {
      title: "Ask (flow)",
      description: "Return discipline to answer a question from the hub's modules.",
      inputSchema: { ...promptArgs, question: z.string().optional().describe("The question to answer.") },
    },
    handler(async (args: { container?: string; module?: string; question?: string }) => {
      const targets = await service.resolveTargets(args.container, args.module);
      return ok(await buildAsk(targets, args.question));
    }),
  );

  server.registerTool(
    "context",
    {
      title: "Context (flow)",
      description: "Return discipline to assemble a task-relevant working set across the hub.",
      inputSchema: {
        container: z.string().optional().describe("Container name (default: all)."),
        task: z.string().optional().describe("The task to prepare for."),
      },
    },
    handler(async (args: { container?: string; task?: string }) => {
      const targets = await service.resolveTargets(args.container);
      return ok(await buildContext(targets, args.task));
    }),
  );

  server.registerTool(
    "learn",
    {
      title: "Learn (flow)",
      description: "Return discipline to integrate new knowledge into a knowledge module (OKF).",
      inputSchema: { ...promptArgs, knowledge: z.string().optional().describe("The candidate knowledge.") },
    },
    handler(async (args: { container?: string; module?: string; knowledge?: string }) => {
      const targets = await service.resolveTargets(args.container, args.module);
      return ok(await buildLearn(targets, args.knowledge));
    }),
  );

  server.registerTool(
    "remember",
    {
      title: "Remember (flow)",
      description: "Return discipline to record an observation into a memory module.",
      inputSchema: { ...promptArgs, observation: z.string().optional().describe("The observation to record.") },
    },
    handler(async (args: { container?: string; module?: string; observation?: string }) => {
      const targets = await service.resolveTargets(args.container, args.module);
      return ok(await buildRemember(targets, args.observation));
    }),
  );

  server.registerTool(
    "reflect",
    {
      title: "Reflect (flow)",
      description: "Return discipline to turn memory/experience into insight and updates.",
      inputSchema: { ...promptArgs, focus: z.string().optional().describe("Optional area to focus on.") },
    },
    handler(async (args: { container?: string; module?: string; focus?: string }) => {
      const targets = await service.resolveTargets(args.container, args.module);
      return ok(await buildReflect(targets, args.focus));
    }),
  );
}
