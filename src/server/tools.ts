import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  AddContainerPlan,
  ContainerService,
  HubMap,
  InspectResult,
  SyncResult,
} from "../container/service.js";
import type { OkhPaths } from "../config.js";
import {
  configFieldMeta,
  configKeys,
  loadPreferences,
  preferencesSchema,
  savePreferences,
  type Preferences,
} from "../preferences.js";
import { buildAddModule, buildAsk, buildContext, buildOnboard, buildRun, buildSleep } from "../prompts/index.js";
import { BUILTIN_MODULE_TYPES } from "../modules/types.js";
import { vendoredSkills } from "../modules/vendored.js";
import { TodoService } from "../todos/service.js";
import { handler, isBlank, fail, ok, toolReg } from "./toolSupport.js";
import { registerTodoTools } from "./todoTools.js";
import {
  createCapabilityProbeOperations,
  runCapabilityProbes,
  formatCapabilityReport,
} from "./capabilityProbes.js";
import { formatSyncDescriptor } from "../util/syncFormat.js";
import { loadPromptFile } from "../prompts/templates.js";

/** Render the no-arg hub map: global skills, module type skills (labeled unambiguously as
 * types), then containers → modules. Module-type skills are listed once per in-use type; only
 * local skills appear on a module line. The routing/usage footer is appended by the handler. */
function formatHub(r: HubMap): string {
  const lines: string[] = [`Hub — wake phrase "${r.wakePhrase}"`, ""];

  lines.push("Global skills (run with no container/module):");
  lines.push(
    ...(r.globalSkills.length
      ? r.globalSkills.map((s) => `  ${s.name}${s.description ? ` — ${s.description}` : ""}`)
      : ["  (none)"]),
  );
  lines.push("");

  const types = Object.keys(r.moduleTypeSkills);
  lines.push("Module type skills (any module of that type can run these):");
  if (types.length === 0) {
    lines.push("  (none)");
  } else {
    for (const type of types) {
      lines.push("", `  Module type "${type}":`);
      lines.push(
        ...r.moduleTypeSkills[type]!.map(
          (s) => `    ${s.name}${s.description ? ` — ${s.description}` : ""}`,
        ),
      );
    }
  }
  lines.push("");

  lines.push("Containers:");
  if (r.containers.length === 0) {
    lines.push("  (none registered — use add_container { source } to register one)");
  } else {
    for (const c of r.containers) {
      const invalid = c.manifestValid
        ? ""
        : ` (invalid manifest${c.manifestError ? `: ${c.manifestError}` : ""})`;
      lines.push(`  ${c.name}  [${c.backend}] sync=${formatSyncDescriptor(c.sync)}${invalid}`);
      if (c.modules.length === 0) {
        lines.push("    (no modules)");
        continue;
      }
      for (const m of c.modules) {
        const local = m.local?.length ? `   +local: ${m.local.map((s) => s.name).join(", ")}` : "";
        const overrides = m.overrides?.length ? ` (overrides: ${m.overrides.join(", ")})` : "";
        const desc = isBlank(m.description ?? "")
          ? " — (no description; run sleep to consolidate one)"
          : ` — ${m.description!.trim()}`;
        lines.push(`    · ${m.path}  (module type: ${m.type})  ${m.items} items${desc}${local}${overrides}`);
      }
    }
  }

  return lines.join("\n");
}

function formatInspect(r: InspectResult): string {
  if (r.kind === "hub") return formatHub(r);
  if (r.kind === "container") {
    const s = r.status;
    const lines = [
      `Container: ${s.name} [${s.backend}]`,
      `Sync: ${formatSyncDescriptor(s.sync)}`,
      `Path: ${s.localPath}`,
      `Manifest valid: ${s.manifestValid}${s.manifestError ? ` (${s.manifestError})` : ""}`,
      "Modules:",
      ...(s.modules.length
        ? s.modules.map((m) => `  - ${m.type}: ${m.path}${isBlank(m.description ?? "") ? " — (no description; run sleep to consolidate one)" : ` — ${m.description!.trim()}`} (${m.items} items)`)
        : ["  (none)"]),
    ];
    if (s.syncActions?.length) {
      lines.push(`Actions: ${s.syncActions.join(", ")}`);
    }
    if (s.git) {
      lines.push(
        `Git: branch=${s.git.branch} dirty=${s.git.dirty} ahead/behind=${s.git.ahead}/${s.git.behind} unpushed=${s.git.hasUnpushedCommits}`,
      );
    }
    return lines.join("\n");
  }
  const head = `Module ${r.module.path} [${r.module.type}]${isBlank(r.module.description ?? "") ? " — (no description; run sleep to consolidate one)" : ` — ${r.module.description!.trim()}`} — ${r.items.length} items`;
  const items = r.items.length
    ? r.items.map((i) => `  - ${i.title}${i.description ? ` — ${i.description}` : ""} (${i.path})`)
    : ["  (empty)"];
  const skillLines = r.skills.length
    ? r.skills.map((s) => {
        // Align the per-skill provenance tag with the hub-map vocabulary: a type-provided
        // skill is a "module type" skill; local skills keep their in-repo source path.
        const provenance = s.source === "vendored" ? "module type" : s.source;
        const location = s.path ? ` [${provenance}:${s.path}]` : ` [${provenance}]`;
        return `  - ${s.name}${s.description ? ` — ${s.description}` : ""}${location}`;
      })
    : ["  (none)"];
  const skillIssueLines = r.skillIssues?.length
    ? ["Skill tree issues:", ...r.skillIssues.map((issue) => `  - ${issue}`)]
    : [];
  const overview = r.overview.trim();
  const overviewLines = overview
    ? ["Scope / overview:", ...overview.split("\n").map((l) => `  ${l}`)]
    : ["Scope / overview:", "  (no overview)"];
  const healthLines: string[] = [];
  if (r.health) {
    const h = r.health;
    const clean = !h.orphans.length && !h.danglingLinks.length && !h.uncataloged.length && !h.missingType.length;
    healthLines.push("Wiki health:");
    if (clean) {
      healthLines.push("  clean");
    } else {
      if (h.orphans.length) healthLines.push(`  Orphans (${h.orphans.length}): ${h.orphans.join(", ")}`);
      if (h.danglingLinks.length)
        healthLines.push(`  Dangling links (${h.danglingLinks.length}): ${h.danglingLinks.map((d) => `${d.from} → ${d.to}`).join(", ")}`);
      if (h.uncataloged.length) healthLines.push(`  Uncataloged (${h.uncataloged.length}): ${h.uncataloged.join(", ")}`);
      if (h.missingType.length) healthLines.push(`  Missing type (${h.missingType.length}): ${h.missingType.join(", ")}`);
    }
  }
  return [
    head,
    ...items,
    "Skills:",
    ...skillLines,
    ...skillIssueLines,
    ...overviewLines,
    ...healthLines,
  ].join("\n");
}

function formatContainerPlan(plan: AddContainerPlan): string {
  const lines = ["Plan (no changes made). Re-run add_container with create:true to apply:"];
  if (plan.actions.includes("create-folder")) lines.push(`- Create folder: ${plan.target}`);
  if (plan.actions.includes("clone"))
    lines.push(`- Clone ${plan.source} → ${plan.target}`);
  lines.push(`- Register container "${plan.name}" [${plan.backend.type}] sync=${formatSyncDescriptor(plan.sync)}`);
  return lines.join("\n");
}

function formatSync(rs: SyncResult[]): string {
  if (rs.length === 0) return "Nothing to sync.";
  return rs
    .map((r) => {
      const v = r.validation.ok ? "valid" : `INVALID: ${r.validation.issues.join("; ")}`;
      const tag = r.error !== undefined
        ? ` error: ${r.error}`
        : r.prUrl
        ? ` PR: ${r.prUrl}`
        : r.branch && r.mode === "shared"
        ? ` branch=${r.branch}`
        : "";
      const line = `- ${r.name} [${r.backend}/${r.mode}] ${r.outcome} (${v})${tag}`;
      const guidance =
        r.mode === "shared" && r.outcome === "synced" && !r.requestedAction && r.branch
          ? `\n  Changes are on ${r.branch}. When ready to publish, call sync with action "publish-pr".`
          : "";
      return line + guidance;
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

export interface RegisterToolsOptions {
  capabilityProbeTimeoutMs?: number;
  todoWebUrl?: string;
}

/** Register the operational tools (`inspect`, `add_container`, `add_module`, `sync`, `config`) plus the flows. */
export async function registerTools(
  server: McpServer,
  service: ContainerService,
  paths: OkhPaths,
  todoService: TodoService,
  options: RegisterToolsOptions = {},
): Promise<void> {
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
      const text =
        result.kind === "hub"
          ? `${formatInspect(result)}\n\n${await loadPromptFile("partials/inspect-usage.md")}`
          : formatInspect(result);
      return ok(text, { result });
    }),
  );

  server.registerTool(
    "add_container",
    { ...(await toolReg("add_container")), annotations: { openWorldHint: true } },
    handler(async (args: { source: string; name?: string; sync?: { mode: "auto" | "shared"; config?: Record<string, unknown> }; backend?: "local" | "onedrive"; create?: boolean }) => {
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
      return ok(`Registered container "${outcome.entry.name}" [${outcome.entry.backend.type}] at ${outcome.entry.localPath}.`, { entry: outcome.entry });
    }),
  );

  server.registerTool(
    "add_module",
    { ...(await toolReg("add_module")), annotations: { openWorldHint: true } },
    handler(async (args: { container?: string; path?: string; type?: string; description?: string; config?: Record<string, unknown>; create?: boolean }) => {
      if (!args.create) {
        const targets = await service.resolveTargets();
        return ok(await buildAddModule(targets, BUILTIN_MODULE_TYPES));
      }
      if (isBlank(args.container ?? "")) return fail("container cannot be empty. (required when create:true)");
      if (isBlank(args.path ?? "")) return fail("path cannot be empty. (required when create:true)");
      if (isBlank(args.type ?? "")) return fail("type cannot be empty. (required when create:true)");
      if (isBlank(args.description ?? "")) return fail("description cannot be empty. (required when create:true — it drives inspect routing; run sleep later to refine it)");
      const outcome = await service.addModule({
        container: args.container!,
        path: args.path!,
        type: args.type!,
        description: args.description!,
        ...(args.config ? { config: args.config } : {}),
        create: true,
      });
      if (outcome.kind !== "applied") return fail("add_module create:true did not apply.");
      const added = `Added ${outcome.entry.type} module "${outcome.entry.path}" to "${args.container}" at ${outcome.moduleRoot}.`;
      const hasInit = (await vendoredSkills(outcome.entry.type)).some((s) => s.name === "initialize");
      const next = hasInit
        ? ` Next, initialize it: run { container: "${args.container}", module: "${outcome.entry.path}", skill: "initialize" }.`
        : "";
      return ok(added + next, { entry: outcome.entry });
    }),
  );

  server.registerTool(
    "sync",
    { ...(await toolReg("sync")), annotations: { openWorldHint: true } },
    handler(async (args: { container?: string; message?: string; /** Named action. Currently supports "publish-pr" for shared-mode containers. */ action?: string }) => {
      if (args.container !== undefined && isBlank(args.container)) return fail("container cannot be empty.");
      const results = await service.sync(args.container, args.message, args.action);
      return ok(formatSync(results), { results });
    }),
  );

  server.registerTool(
    "config",
    { ...(await toolReg("config", { vars: { configKeys: configKeys.join(", ") } })), annotations: { readOnlyHint: false, openWorldHint: false } },
    handler(async (args: { set?: Record<string, unknown>; container?: string; module?: string; description?: string }) => {
      const wantsSetDescription =
        args.container !== undefined || args.module !== undefined || args.description !== undefined;
      if (wantsSetDescription) {
        if (args.set !== undefined) {
          return fail("Provide either { set } (preferences) or { container, module, description } (module description), not both.");
        }
        if (isBlank(args.container ?? "")) return fail("container cannot be empty. (required to set a module description)");
        if (isBlank(args.module ?? "")) return fail("module cannot be empty. (required to set a module description)");
        if (isBlank(args.description ?? "")) return fail("description cannot be empty.");
        await service.setModuleDescription(args.container!, args.module!, args.description!);
        return ok(`Updated description for module "${args.module}" in container "${args.container}".`, {
          container: args.container,
          module: args.module,
          description: args.description!.trim(),
        });
      }
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
  await registerTodoTools(server, todoService, {
    ...(options.todoWebUrl !== undefined ? { webUrl: options.todoWebUrl } : {}),
  });

  server.registerTool(
    "capabilities",
    { ...(await toolReg("capabilities")), annotations: { readOnlyHint: true, openWorldHint: false } },
    handler(async () => {
      const ops = createCapabilityProbeOperations(server, options.capabilityProbeTimeoutMs);
      const report = await runCapabilityProbes(ops);
      return ok(formatCapabilityReport(report), { features: report.features });
    }),
  );
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

  server.registerTool(
    "sleep",
    { ...(await toolReg("sleep")), annotations: { readOnlyHint: true } },
    handler(async (args: { container?: string; module?: string }) => {
      if (args.module !== undefined && !isBlank(args.module) && isBlank(args.container ?? "")) {
        return fail("sleep needs a container when a module is given (module names are not unique across containers).");
      }
      const skill = await service.resolveSharedSkill("dream");
      const targets = await service.resolveTargets(args.container, args.module);
      return ok(await buildSleep(skill, targets));
    }),
  );
}
