import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  AddContainerPlan,
  AddModulePlan,
  ContainerService,
  InspectResult,
  SyncResult,
} from "../container/service.js";
import type { OkhPaths } from "../config.js";
import { isOkhError } from "../errors.js";
import {
  configFieldMeta,
  configKeys,
  loadPreferences,
  preferencesSchema,
  savePreferences,
  type Preferences,
} from "../preferences.js";
import { buildAsk, buildContext, buildLearn, buildOnboard, buildReflect, buildRemember } from "../prompts/index.js";
import { flowArgShapes, flowMeta } from "../prompts/meta.js";

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
        ? s.modules.map((m) => `  - ${m.type} · ${m.name}${m.description ? ` — ${m.description}` : ""}: ${m.path} (${m.items} items)`)
        : ["  (none)"]),
    ];
    if (s.git) {
      lines.push(
        `Git: branch=${s.git.branch} dirty=${s.git.dirty} ahead/behind=${s.git.ahead}/${s.git.behind} unpushed=${s.git.hasUnpushedCommits}`,
      );
    }
    return lines.join("\n");
  }
  const head = `Module ${r.module.path} [${r.module.type}] ${r.module.name}${r.module.description ? ` — ${r.module.description}` : ""} — ${r.items.length} items`;
  const items = r.items.length
    ? r.items.map((i) => `  - ${i.title}${i.description ? ` — ${i.description}` : ""} (${i.path})`)
    : ["  (empty)"];
  return [head, ...items].join("\n");
}

function formatContainerPlan(plan: AddContainerPlan): string {
  const lines = ["Plan (no changes made). Re-run add with create:true to apply:"];
  if (plan.actions.includes("create-folder")) lines.push(`- Create folder: ${plan.target}`);
  if (plan.actions.includes("clone"))
    lines.push(`- Clone ${plan.source} → ${plan.target}`);
  lines.push(`- Register container "${plan.name}" [${plan.backend}]`);
  return lines.join("\n");
}

function formatModulePlan(plan: AddModulePlan): string {
  const lines = ["Plan (no changes made). Re-run add with create:true to apply:"];
  if (plan.actions.includes("create-folder")) lines.push(`- Create folder: ${plan.moduleRoot}`);
  if (plan.actions.includes("scaffold")) lines.push(`- Scaffold ${plan.type} module content`);
  lines.push(`- Add ${plan.type} module "${plan.name}" at "${plan.path}" to "${plan.container}"`);
  return lines.join("\n");
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

function formatConfig(prefs: Preferences, paths: OkhPaths): string {
  const lines = [`Config (${paths.preferencesFile}):`];
  for (const { key, description } of configFieldMeta) {
    const value = (prefs as Record<string, unknown>)[key];
    lines.push(`- ${key}: ${JSON.stringify(value)} — ${description}`);
  }
  return lines.join("\n");
}

function describeConfigError(err: z.ZodError): string {
  for (const issue of err.issues) {
    if (issue.code === "unrecognized_keys") {
      return `Unknown config key(s): ${issue.keys.join(", ")}. Valid keys: ${configKeys.join(", ")}.`;
    }
  }
  const first = err.issues[0];
  const key = first?.path.join(".") || "config";
  return `Invalid value for "${key}": ${first?.message ?? "invalid value"}.`;
}

/** Register the four operational tools (`inspect`, `add`, `sync`, `config`) plus the six flows. */
export function registerTools(server: McpServer, service: ContainerService, paths: OkhPaths): void {
  server.registerTool(
    "inspect",
    {
      title: "Inspect containers/modules",
      description:
        "List registered containers (no args), a container's modules + status (container), or a module's items (container + module).",
      annotations: { readOnlyHint: true },
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
        "or add a module with { container, path, type, config? }. " +
        "By default add returns a plan and makes no changes; show it to the user, get confirmation, then re-call with create:true.",
      annotations: { openWorldHint: true },
      inputSchema: {
        source: z.string().optional().describe("Git URL or local/OneDrive path (new container)."),
        name: z.string().optional().describe("Container name (defaults to the source basename) or module display name."),
        sync: z.enum(["auto", "pr"]).optional().describe("Git write mode for a new container."),
        backend: z.enum(["local", "onedrive"]).optional().describe("Label a path source as local or onedrive."),
        container: z.string().optional().describe("Target container (new module)."),
        path: z.string().optional().describe("Module folder path within the container (new module)."),
        type: z.string().min(1).optional().describe("Module type: a built-in (knowledge, skills, tools, memory, project) or a custom type name (new module)."),
        description: z.string().optional().describe("One-line module description (new module)."),
        config: z.record(z.string(), z.unknown()).optional().describe("Optional module config."),
        create: z.boolean().optional().describe("Apply the change. Omit to preview a plan (no changes)."),
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
        type?: string;
        description?: string;
        config?: Record<string, unknown>;
        create?: boolean;
      }) => {
        const hasSource = args.source !== undefined;
        const hasModuleFields =
          args.container !== undefined || args.path !== undefined || args.type !== undefined || args.description !== undefined || args.config !== undefined;
        if (hasSource && hasModuleFields) {
          return fail("add requires either { source } or { container, path, type }, not both.");
        }
        if (args.source !== undefined) {
          if (isBlank(args.source)) return fail("source cannot be empty.");
          const outcome = await service.addContainer({
            source: args.source,
            ...(args.name ? { name: args.name } : {}),
            ...(args.sync ? { sync: args.sync } : {}),
            ...(args.backend ? { backend: args.backend } : {}),
            ...(args.create ? { create: true } : {}),
          });
          if (outcome.kind === "plan") {
            return ok(formatContainerPlan(outcome.plan), { plan: outcome.plan, needsConfirmation: true });
          }
          return ok(`Registered container "${outcome.entry.name}" [${outcome.entry.backend}] at ${outcome.entry.localPath}.`, { entry: outcome.entry });
        }
        if (hasModuleFields) {
          if (args.container === undefined || args.path === undefined || args.type === undefined || args.name === undefined) {
            return fail("Adding a module requires { container, path, type, name }.");
          }
          if (isBlank(args.container)) return fail("container cannot be empty.");
          if (isBlank(args.path)) return fail("path cannot be empty.");
          if (isBlank(args.name)) return fail("name cannot be empty.");
          const outcome = await service.addModule({
            container: args.container,
            path: args.path,
            type: args.type,
            name: args.name,
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.config ? { config: args.config } : {}),
            ...(args.create ? { create: true } : {}),
          });
          if (outcome.kind === "plan") {
            return ok(formatModulePlan(outcome.plan), { plan: outcome.plan, needsConfirmation: true });
          }
          return ok(`Added ${outcome.entry.type} module "${outcome.entry.name}" at "${outcome.entry.path}" to "${args.container}" at ${outcome.moduleRoot}.`, { entry: outcome.entry });
        }
        return fail("add requires either { source } (new container) or { container, path, type, name } (new module).");
      },
    ),
  );

  server.registerTool(
    "sync",
    {
      title: "Sync containers",
      description:
        "Validate and synchronize a container (or all containers). Git containers commit+push (auto) or open a PR (pr).",
      annotations: { openWorldHint: true },
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

  server.registerTool(
    "config",
    {
      title: "Config (view or change settings)",
      description:
        "View or change OKH configuration (stored in preferences.json). Call with no args to list current " +
        "settings; pass { set: { <key>: <value> } } to change one or more. Known keys: " +
        `${configKeys.join(", ")}.`,
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        set: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Config keys to set, e.g. { wakePhrase: "brain" }. Omit to list current config.'),
      },
    },
    handler(async (args: { set?: Record<string, unknown> }) => {
      if (args.set === undefined) {
        const prefs = await loadPreferences(paths);
        return ok(formatConfig(prefs, paths), { preferences: prefs, keys: configKeys });
      }
      if (Object.keys(args.set).length === 0) {
        return fail("config { set } must include at least one key.", `Valid keys: ${configKeys.join(", ")}.`);
      }
      const current = await loadPreferences(paths);
      const parsed = preferencesSchema.safeParse({ ...current, ...args.set });
      if (!parsed.success) return fail(describeConfigError(parsed.error));
      await savePreferences(paths, parsed.data);
      const changed = Object.keys(args.set);
      const restartNote = changed.includes("wakePhrase")
        ? ` The wake phrase takes effect on the next client restart; you can already say "${parsed.data.wakePhrase}, …".`
        : "";
      return ok(`Updated ${changed.join(", ")}.${restartNote}\n\n${formatConfig(parsed.data, paths)}`, {
        preferences: parsed.data,
        changed,
      });
    }),
  );

  server.registerTool(
    "onboard",
    {
      title: flowMeta.onboard.title,
      description: flowMeta.onboard.description,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: flowArgShapes.onboard,
    },
    handler(async () => {
      const { wakePhrase } = await loadPreferences(paths);
      const targets = await service.resolveTargets();
      return ok(await buildOnboard(targets, wakePhrase));
    }),
  );

  registerFlowTools(server, service);
}

/**
 * The five cognitive flows, exposed as tools for clients without prompt support.
 * Like all flows they return discipline text (instructions) for the agent to
 * follow — they do not read or write on their own. `onboard` is the sixth flow,
 * registered above alongside the operational tools.
 */
function registerFlowTools(server: McpServer, service: ContainerService): void {
  server.registerTool(
    "ask",
    {
      title: flowMeta.ask.title,
      description: flowMeta.ask.description,
      annotations: { readOnlyHint: true },
      inputSchema: flowArgShapes.ask,
    },
    handler(async (args: { container?: string; module?: string; question?: string }) => {
      const targets = await service.resolveTargets(args.container, args.module);
      return ok(await buildAsk(targets, args.question));
    }),
  );

  server.registerTool(
    "context",
    {
      title: flowMeta.context.title,
      description: flowMeta.context.description,
      annotations: { readOnlyHint: true },
      inputSchema: flowArgShapes.context,
    },
    handler(async (args: { container?: string; task?: string }) => {
      const targets = await service.resolveTargets(args.container);
      return ok(await buildContext(targets, args.task));
    }),
  );

  server.registerTool(
    "learn",
    {
      title: flowMeta.learn.title,
      description: flowMeta.learn.description,
      annotations: { readOnlyHint: true },
      inputSchema: flowArgShapes.learn,
    },
    handler(async (args: { container?: string; module?: string; knowledge?: string }) => {
      const targets = await service.resolveTargets(args.container, args.module);
      return ok(await buildLearn(targets, args.knowledge));
    }),
  );

  server.registerTool(
    "remember",
    {
      title: flowMeta.remember.title,
      description: flowMeta.remember.description,
      annotations: { readOnlyHint: true },
      inputSchema: flowArgShapes.remember,
    },
    handler(async (args: { container?: string; module?: string; observation?: string }) => {
      const targets = await service.resolveTargets(args.container, args.module);
      return ok(await buildRemember(targets, args.observation));
    }),
  );

  server.registerTool(
    "reflect",
    {
      title: flowMeta.reflect.title,
      description: flowMeta.reflect.description,
      annotations: { readOnlyHint: true },
      inputSchema: flowArgShapes.reflect,
    },
    handler(async (args: { container?: string; module?: string; focus?: string }) => {
      const targets = await service.resolveTargets(args.container, args.module);
      return ok(await buildReflect(targets, args.focus));
    }),
  );
}
