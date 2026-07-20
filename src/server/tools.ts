import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  AddContainerPlan,
  ContainerService,
  HubMap,
  InspectResult,
  SyncResult,
} from "../container/service.js";
import type { OkhPaths } from "../config.js";
import type { ModuleManifest } from "../modules/manifest.js";
import {
  configFieldMeta,
  configKeys,
  loadPreferences,
  preferencesSchema,
  savePreferences,
  type Preferences,
} from "../preferences.js";
import {
  buildAddModule,
  buildAsk,
  buildContext,
  buildDream,
  buildHelp,
  buildOnboard,
  buildRun,
} from "../prompts/index.js";
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
import type { OkhResourceRegistry } from "../resources/index.js";
import { chunkResourceResult } from "../resources/embedding.js";
import { renderUseAgentResult } from "./agentDelegation.js";
import type { WorkspaceService } from "../workspaces/service.js";
import { registerWorkspaceTool } from "./workspaceTool.js";

/** Render the no-arg hub map with every runnable skill nested under its module. */
function formatHub(r: HubMap): string {
  let moduleExample: { container: string; module: string; skill: string } | undefined;
  for (const c of r.containers) {
    for (const m of c.modules) {
      const skill = m.skills[0]?.name;
      if (skill) {
        moduleExample = { container: c.name, module: m.path, skill };
        break;
      }
    }
    if (moduleExample) break;
  }
  const hasWorkspace = r.containers.some((container) =>
    container.modules.some((module) => module.type === "workspace")
  );

  const lines: string[] = [
    "# Hub",
    `Wake phrase: "${r.wakePhrase}"`,
    "",
    "# Run a module skill",
    "Run any skill listed beneath a module with the `run` tool. Example:",
    moduleExample
      ? `- run { container: ${JSON.stringify(moduleExample.container)}, module: ${JSON.stringify(moduleExample.module)}, skill: ${JSON.stringify(moduleExample.skill)} }`
      : "- run { container: \"<container>\", module: \"<module>\", skill: \"<skill>\" }",
    "`run` returns the skill's instructions for you to carry out — it does not do the work itself.",
    "",
  ];

  if (hasWorkspace) {
    lines.push(
      "# Workspace project discovery",
      "When an existing project is named without its exact container/module, call `workspace`",
      "with `operation: \"list\"` and the project query in every workspace module.",
      "Search all of them even after the first match. Select only after every workspace",
      "responds; if more than one matches, ask the user to choose.",
      "Never infer a project's location from its name, artifact type, or the first match.",
      "After selecting one unique match, call `workspace:get` for that project before",
      "deciding, acting, or refusing; list summaries are discovery-only.",
      "Before project execution, run the workspace's `coordinate` skill. If `get` reports",
      "an active run, never probe `start` for a concurrent run; explain the invariant.",
      "",
    );
  }

  lines.push("# Module skills");
  lines.push("Every runnable skill is scoped to the module where it appears.");
  if (r.containers.length === 0) {
    lines.push("- (no containers registered — use add_container { source } to register one)");
  } else {
    for (const c of r.containers) {
      const invalid = c.manifestValid
        ? ""
        : ` (invalid manifest${c.manifestError ? `: ${c.manifestError}` : ""})`;
      lines.push(`- ${c.name}  [${c.backend}] sync=${formatSyncDescriptor(c.sync)}${invalid}`);
      if (c.modules.length === 0) {
        lines.push("  - (no modules)");
        continue;
      }
      for (const m of c.modules) {
        const desc = isBlank(m.description ?? "")
          ? " — (no description; run dream to consolidate one)"
          : ` — ${m.description!.trim()}`;
        lines.push(`  - ${m.path}  (module type: ${m.type})  ${m.items} items${desc}`);
        if (m.skills.length) {
          lines.push("    - runnable skills:");
          lines.push(...m.skills.map((skill) => {
            const origin = skill.origin === "module-type"
              ? "module type"
              : skill.path
                ? `module local: ${skill.path}`
                : "module local";
            const overridden = skill.overridesModuleType ? " (overrides module type)" : "";
            return `      - ${skill.name}${skill.description ? ` — ${skill.description}` : ""} [${origin}]${overridden}`;
          }));
        } else {
          lines.push("    - (no runnable skills)");
        }
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
        ? s.modules.map((m) => `  - ${m.type}: ${m.path}${isBlank(m.description ?? "") ? " — (no description; run dream to consolidate one)" : ` — ${m.description!.trim()}`} (${m.items} items)`)
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
  const head = `Module ${r.module.path} [${r.module.type}]${isBlank(r.module.description ?? "") ? " — (no description; run dream to consolidate one)" : ` — ${r.module.description!.trim()}`} — ${r.items.length} items`;
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
  const itemIssueLines = r.itemIssues?.length
    ? ["Item issues:", ...r.itemIssues.map((issue) => `  - ${issue}`)]
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
    ...itemIssueLines,
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
  const known = new Set<string>(configKeys);
  for (const { key, description } of configFieldMeta) {
    const value = (prefs as Record<string, unknown>)[key];
    lines.push(`- ${key}: ${JSON.stringify(value)} — ${description}`);
  }
  for (const [key, value] of Object.entries(prefs as Record<string, unknown>)) {
    if (known.has(key)) continue;
    lines.push(`- ${key}: ${JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

function formatModuleConfig(container: string, module: string, m: ModuleManifest): string {
  const lines = [`Module config — ${container}/${module}:`];
  lines.push(`- type: ${JSON.stringify(m.type)} — identity (selects the loader; not settable via config)`);
  lines.push(`- description: ${JSON.stringify(m.description)} — drives inspect routing`);
  const cfg = m.config ?? {};
  const keys = Object.keys(cfg);
  if (keys.length === 0) {
    lines.push("- (no additional config keys)");
  } else {
    for (const key of keys) lines.push(`- ${key}: ${JSON.stringify(cfg[key])}`);
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
  workspaceService: WorkspaceService,
  resources: OkhResourceRegistry,
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
    "use_agent",
    {
      ...(await toolReg("use_agent")),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async (args: {
      container: string;
      module: string;
      agent: string;
      task: string;
    }) => {
      if (isBlank(args.container)) return fail("container cannot be empty.");
      if (isBlank(args.module)) return fail("module cannot be empty.");
      if (isBlank(args.agent)) return fail("agent cannot be empty.");
      if (isBlank(args.task)) return fail("task cannot be empty.");
      const profile = await service.resolveAgentProfile(
        args.container,
        args.module,
        args.agent,
      );
      return renderUseAgentResult(args.container, args.module, profile, args.task);
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
      await server.sendResourceListChanged();
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
      if (isBlank(args.description ?? "")) return fail("description cannot be empty. (required when create:true — it drives inspect routing; run dream later to refine it)");
      const outcome = await service.addModule({
        container: args.container!,
        path: args.path!,
        type: args.type!,
        description: args.description!,
        ...(args.config ? { config: args.config } : {}),
        create: true,
      });
      if (outcome.kind !== "applied") return fail("add_module create:true did not apply.");
      await server.sendResourceListChanged();
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
      await server.sendResourceListChanged();
      return ok(formatSync(results), { results });
    }),
  );

  server.registerTool(
    "config",
    { ...(await toolReg("config", { vars: { configKeys: configKeys.join(", ") } })), annotations: { readOnlyHint: false, openWorldHint: false } },
    handler(async (args: { set?: Record<string, unknown>; container?: string; module?: string }) => {
      const moduleScope = !isBlank(args.container ?? "") || !isBlank(args.module ?? "");

      // Module scope: view or edit a module's manifest config.
      if (moduleScope) {
        if (isBlank(args.container ?? "")) {
          return fail("container is required to view or edit a module's config.");
        }
        if (isBlank(args.module ?? "")) {
          return fail("module is required to view or edit a module's config (module names are not unique across containers).");
        }
        const container = args.container!;
        const module = args.module!;
        if (args.set === undefined) {
          const manifest = await service.getModuleManifest(container, module);
          return ok(formatModuleConfig(container, module, manifest), {
            container,
            module,
            manifest,
          });
        }
        if (Object.keys(args.set).length === 0) {
          return fail("config { set } must include at least one key.");
        }
        const update = await service.setModuleConfigWithChanges(container, module, args.set);
        const { manifest } = update;
        if (update.descriptionChanged) {
          await server.sendResourceListChanged();
        }
        const changed = Object.keys(args.set);
        return ok(
          `Updated ${changed.join(", ")} for module "${module}" in container "${container}".\n\n${formatModuleConfig(container, module, manifest)}`,
          { container, module, changed, manifest },
        );
      }

      // Global scope: view or edit preferences.
      if (args.set === undefined) {
        const prefs = await loadPreferences(paths);
        return ok(formatConfig(prefs, paths), { preferences: prefs, keys: configKeys });
      }
      if (Object.keys(args.set).length === 0) {
        return fail("config { set } must include at least one key.", `Known keys: ${configKeys.join(", ")}.`);
      }
      const current = await loadPreferences(paths);
      const merged: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(args.set)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      const parsed = preferencesSchema.safeParse(merged);
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
    "read_resource",
    {
      ...(await toolReg("read_resource")),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async (args: {
      uri: string;
      contentIndex?: number;
      offset?: number;
      maxBytes?: number;
    }) => {
      if (isBlank(args.uri)) return fail("uri cannot be empty.");
      let result;
      try {
        result = await resources.read(args.uri);
      } catch (error) {
        if (error instanceof McpError) return fail(error.message);
        throw error;
      }
      const chunk = chunkResourceResult(result, {
        ...(args.contentIndex !== undefined ? { contentIndex: args.contentIndex } : {}),
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.maxBytes !== undefined ? { maxBytes: args.maxBytes } : {}),
      });
      const end = chunk.offset + chunk.returnedBytes;
      const continuation = chunk.nextOffset !== undefined
        ? ` Continue with read_resource { uri: ${JSON.stringify(args.uri)},`
          + ` contentIndex: ${chunk.contentIndex}, offset: ${chunk.nextOffset} }.`
        : " End of content.";
      return ok(
        `Read ${JSON.stringify(args.uri)} content ${chunk.contentIndex + 1}`
        + `/${chunk.contentCount}, bytes [${chunk.offset}, ${end})`
        + ` of ${chunk.totalBytes}.${continuation}`,
        {
          uri: args.uri,
          contentIndex: chunk.contentIndex,
          contentCount: chunk.contentCount,
          offset: chunk.offset,
          returnedBytes: chunk.returnedBytes,
          totalBytes: chunk.totalBytes,
          ...(chunk.nextOffset !== undefined ? { nextOffset: chunk.nextOffset } : {}),
          ...(chunk.mimeType ? { mimeType: chunk.mimeType } : {}),
        },
        [],
        [chunk.embeddedResource],
      );
    }),
  );

  server.registerTool(
    "help",
    { ...(await toolReg("help")), annotations: { readOnlyHint: true, openWorldHint: false } },
    handler(async (args: { question?: string }) => {
      const selected = await resources.helpResources(args.question);
      const embedded = new Set(selected.embeddedUris);
      return ok(
        await buildHelp(args.question, selected.links.map(({ uri }) => ({
          uri,
          embedded: embedded.has(uri),
        }))),
        {
          resources: selected.links.map(({ uri, name, title, description }) => ({
            uri,
            name,
            title,
            description,
            embedded: embedded.has(uri),
          })),
          deferredUris: selected.deferredUris,
        },
        selected.links,
        selected.embeddedResources,
      );
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

  await registerFlowTools(server, service, resources);
  await registerWorkspaceTool(server, workspaceService);
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
async function registerFlowTools(
  server: McpServer,
  service: ContainerService,
  resources: OkhResourceRegistry,
): Promise<void> {
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
    handler(async (args: { container: string; module: string; skill: string; input?: string }) => {
      if (isBlank(args.container)) return fail("container cannot be empty.");
      if (isBlank(args.module)) return fail("module cannot be empty.");
      if (isBlank(args.skill)) return fail("skill cannot be empty.");
      const skill = await service.resolveSkill(args.container, args.module, args.skill);
      const targets = await service.resolveTargets(args.container, args.module);
      const target = targets[0];
      const mod = target?.modules.find((m) => m.path === args.module);
      if (!target || !mod) return fail(`Container "${args.container}" has no module "${args.module}".`);
      const selected = await resources.skillResources(skill, target, mod);
      const required = new Set(selected.requiredUris);
      const embedded = new Set(selected.embeddedUris);
      return ok(
        await buildRun(
          skill,
          target,
          mod,
          args.input,
          selected.requiredUris.map((uri) => ({ uri, embedded: embedded.has(uri) })),
        ),
        {
          resources: selected.links.map(({ uri, name, title, description }) => ({
            uri,
            name,
            title,
            description,
            required: required.has(uri),
            embedded: embedded.has(uri),
          })),
          deferredRequiredUris: selected.deferredUris,
        },
        selected.links,
        selected.embeddedResources,
      );
    }),
  );

  server.registerTool(
    "dream",
    { ...(await toolReg("dream")), annotations: { readOnlyHint: true } },
    handler(async (args: { container?: string; module?: string }) => {
      if (args.module !== undefined && !isBlank(args.module) && isBlank(args.container ?? "")) {
        return fail("dream needs a container when a module is given (module names are not unique across containers).");
      }
      const targets = await service.resolveTargets(args.container, args.module);
      return ok(await buildDream(targets));
    }),
  );
}
