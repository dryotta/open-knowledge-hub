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
import { buildAsk, buildContext, buildOnboard, buildRun } from "../prompts/index.js";
import { loadToolMeta, describeShape } from "./toolMeta.js";
import { toolShapes, type ToolName } from "./toolSchemas.js";
import type { RenderContext } from "../prompts/templates.js";

async function toolReg<N extends ToolName>(name: N, ctx?: RenderContext) {
  const m = await loadToolMeta(name, ctx);
  return { title: m.title, description: m.description, inputSchema: describeShape(toolShapes[name], m.args) };
}

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
    if (r.containers.length === 0) return "No containers registered. Use add_container { source } to register one.";
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
  const skillLines = r.skills.length
    ? r.skills.map((s) => `  - ${s.name} — ${s.description}`)
    : ["  (none)"];
  return [head, ...items, "Skills:", ...skillLines].join("\n");
}

function formatContainerPlan(plan: AddContainerPlan): string {
  const lines = ["Plan (no changes made). Re-run add_container with create:true to apply:"];
  if (plan.actions.includes("create-folder")) lines.push(`- Create folder: ${plan.target}`);
  if (plan.actions.includes("clone"))
    lines.push(`- Clone ${plan.source} → ${plan.target}`);
  lines.push(`- Register container "${plan.name}" [${plan.backend}]`);
  return lines.join("\n");
}

function formatModulePlan(plan: AddModulePlan): string {
  const lines = ["Plan (no changes made). Re-run add_module with create:true to apply:"];
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

/** Register the operational tools (`inspect`, `add_container`, `add_module`, `sync`, `config`) plus the flows. */
export async function registerTools(server: McpServer, service: ContainerService, paths: OkhPaths): Promise<void> {
  server.registerTool(
    "inspect",
    { ...(await toolReg("inspect")), annotations: { readOnlyHint: true } },
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
    "add_container",
    { ...(await toolReg("add_container")), annotations: { openWorldHint: true } },
    handler(async (args: { source: string; name?: string; sync?: "auto" | "pr"; backend?: "local" | "onedrive"; create?: boolean }) => {
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
    }),
  );

  server.registerTool(
    "add_module",
    { ...(await toolReg("add_module")), annotations: { openWorldHint: true } },
    handler(async (args: { container: string; path: string; type: string; name: string; description?: string; config?: Record<string, unknown>; create?: boolean }) => {
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
      const added = `Added ${outcome.entry.type} module "${outcome.entry.name}" at "${outcome.entry.path}" to "${args.container}" at ${outcome.moduleRoot}.`;
      const next =
        outcome.entry.type === "knowledge"
          ? ` Next, populate it by running the initialize skill: run { container: "${args.container}", module: "${outcome.entry.path}", skill: "initialize" }.`
          : "";
      return ok(added + next, { entry: outcome.entry });
    }),
  );

  server.registerTool(
    "sync",
    { ...(await toolReg("sync")), annotations: { openWorldHint: true } },
    handler(async (args: { container?: string; message?: string }) => {
      if (args.container !== undefined && isBlank(args.container)) return fail("container cannot be empty.");
      const results = await service.sync(args.container, args.message);
      return ok(formatSync(results), { results });
    }),
  );

  server.registerTool(
    "config",
    { ...(await toolReg("config", { vars: { configKeys: configKeys.join(", ") } })), annotations: { readOnlyHint: false, openWorldHint: false } },
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
    { ...(await toolReg("onboard")), annotations: { readOnlyHint: true, openWorldHint: false } },
    handler(async () => {
      const { wakePhrase } = await loadPreferences(paths);
      const targets = await service.resolveTargets();
      return ok(await buildOnboard(targets, { wakePhrase }));
    }),
  );

  await registerFlowTools(server, service);
}

/**
 * The cognitive flows, exposed as tools. Like all flows they return discipline
 * text (instructions) for the agent to follow — they do not read or write on
 * their own. `onboard` is another flow, registered above with the operational tools.
 */
async function registerFlowTools(server: McpServer, service: ContainerService): Promise<void> {
  server.registerTool(
    "ask",
    { ...(await toolReg("ask")), annotations: { readOnlyHint: true } },
    handler(async (args: { container?: string; module?: string; question?: string }) => {
      const targets = await service.resolveTargets(args.container, args.module);
      return ok(await buildAsk(targets, args.question));
    }),
  );

  server.registerTool(
    "context",
    { ...(await toolReg("context")), annotations: { readOnlyHint: true } },
    handler(async (args: { container?: string; task?: string }) => {
      const targets = await service.resolveTargets(args.container);
      return ok(await buildContext(targets, args.task));
    }),
  );

  server.registerTool(
    "run",
    { ...(await toolReg("run")), annotations: { readOnlyHint: true } },
    handler(async (args: { container?: string; module?: string; skill: string; input?: string }) => {
      const hasContainer = args.container !== undefined && !isBlank(args.container);
      const hasModule = args.module !== undefined && !isBlank(args.module);
      if (hasContainer !== hasModule) {
        return fail("run needs both container and module (module skill), or neither (shared skill).");
      }
      if (!hasContainer) {
        const skill = await service.resolveSharedSkill(args.skill);
        return ok(await buildRun(skill, args.input));
      }
      const skill = await service.resolveSkill(args.container!, args.module!, args.skill);
      const targets = await service.resolveTargets(args.container!, args.module!);
      const target = targets[0];
      const mod = target?.modules.find((m) => m.path === args.module);
      if (!target || !mod) return fail(`Container "${args.container}" has no module "${args.module}".`);
      return ok(await buildRun(skill, args.input, target, mod));
    }),
  );
}
