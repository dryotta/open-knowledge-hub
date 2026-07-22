import type { ResolvedContainer, ResolvedModule } from "../container/service.js";
import type { Skill } from "../modules/skills.js";
import type { AgentsFileResult } from "../modules/agentsFile.js";
import { renderTemplate } from "./templates.js";
import { formatSyncDescriptor } from "../util/syncFormat.js";

const NONE = "(none provided — clarify with the user)";

export interface ResourceStatus {
  uri: string;
  embedded: boolean;
}

function renderResourceStatuses(
  resources: readonly ResourceStatus[],
  empty: string,
): string {
  if (resources.length === 0) return empty;
  return resources.map(({ uri, embedded }) =>
    embedded
      ? `- \`${uri}\` — embedded in this tool result`
      : `- \`${uri}\` — call \`read_resource { uri: ${JSON.stringify(uri)} }\` before continuing`,
  ).join("\n");
}

/** Render the target containers -> modules -> absolute paths as a markdown list. */
function renderTargets(targets: ResolvedContainer[]): string {
  if (targets.length === 0) return "_No containers are registered. Use the `add_container` tool first._";
  return targets
    .map((c) => {
      const header = `- **${c.name}** (${c.backend}, sync: ${formatSyncDescriptor(c.sync)}) — \`${c.root}\``;
      const mods = c.modules.length
        ? c.modules.map((m) => `    - ${m.type}: \`${m.path}\` → \`${m.absPath}\``).join("\n")
        : "    - _(no modules)_";
      return `${header}\n${mods}`;
    })
    .join("\n");
}

export function buildInstructions(config: Record<string, unknown>): Promise<string> {
  return renderTemplate("instructions", { config });
}

export function buildAsk(targets: ResolvedContainer[], question?: string): Promise<string> {
  return renderTemplate("ask", { vars: { question: question ?? NONE, targets: renderTargets(targets) } });
}

export function buildContext(targets: ResolvedContainer[], task?: string): Promise<string> {
  return renderTemplate("context", { vars: { task: task ?? NONE, targets: renderTargets(targets) } });
}

export function buildOnboard(targets: ResolvedContainer[], config: Record<string, unknown>): Promise<string> {
  return renderTemplate("onboard", { config, vars: { targets: renderTargets(targets) } });
}

export function buildAddModule(targets: ResolvedContainer[], moduleTypes: readonly string[]): Promise<string> {
  return renderTemplate("add_module", {
    vars: { targets: renderTargets(targets), moduleTypes: moduleTypes.join(", ") },
  });
}

/** Render a module-scoped skill run. */
export function buildRun(
  skill: Skill,
  target: ResolvedContainer,
  module: ResolvedModule,
  input?: string,
  requiredResources: readonly ResourceStatus[] = [],
): Promise<string> {
  const targetBlock =
    `# Target\n`
    + `- Module: ${module.type} · \`${module.path}\` → \`${module.absPath}\`\n`
    + `- Container: ${target.name} (${target.backend}, sync: ${formatSyncDescriptor(target.sync)}) — \`${target.root}\`\n\n`;
  return renderTemplate("run", {
    vars: {
      skill: { name: skill.name, description: skill.description, body: skill.body },
      input: input ?? NONE,
      target: targetBlock,
      resources: renderResourceStatuses(
        requiredResources,
        "_This skill declares no required MCP resources._",
      ),
    },
  });
}

function renderEnterSkills(skills: readonly Skill[]): string {
  if (skills.length === 0) return "_This module has no skills._";
  return skills
    .map((s) => `- \`${s.name}\`${s.description ? ` — ${s.description}` : ""}`)
    .join("\n");
}

function renderEnterAgents(agents: AgentsFileResult, module: ResolvedModule): string {
  if (agents.status === "present") return agents.content.trim();
  if (agents.status === "unsafe") {
    return `_An \`AGENTS.md\` exists at the module root but was not loaded: ${agents.reason}._`;
  }
  const hint =
    module.type === "folder"
      ? ' Run `run { container, module, skill: "initialize" }` to author one.'
      : "";
  return `_No \`AGENTS.md\` at the module root._${hint}`;
}

/** Render the "enter" result: working-folder declaration + AGENTS.md + skills + write policy. */
export function buildEnter(
  target: ResolvedContainer,
  module: ResolvedModule,
  skills: readonly Skill[],
  agents: AgentsFileResult,
): Promise<string> {
  const targetBlock =
    `# Target\n`
    + `- Module: ${module.type} · \`${module.path}\` → \`${module.absPath}\`\n`
    + `- Container: ${target.name} (${target.backend}, sync: ${formatSyncDescriptor(target.sync)}) — \`${target.root}\`\n\n`;
  return renderTemplate("enter", {
    vars: {
      target: targetBlock,
      agents: renderEnterAgents(agents, module),
      skills: renderEnterSkills(skills),
    },
  });
}

export function buildHelp(
  question: string | undefined,
  resources: readonly ResourceStatus[],
): Promise<string> {
  return renderTemplate("help", {
    vars: {
      question: question?.trim() || "Explain how to use Open Knowledge Hub effectively.",
      resources: renderResourceStatuses(
        resources,
        "_No matching canonical resources were selected._",
      ),
    },
  });
}

/** Render a "dream" consolidation run: the consolidation instructions applied to the resolved target module(s). */
export async function buildDream(targets: ResolvedContainer[]): Promise<string> {
  const modules = targets.flatMap((c) => c.modules.map((module) => ({ container: c, module })));
  const list = modules.length
    ? modules
        .map(({ container, module }) =>
          `- **${module.path}** (${module.type}) in container **${container.name}**\n` +
          `    - overview / index: \`${module.absPath}/index.md\`\n` +
          `    - current description: ${module.description ? `"${module.description}"` : "_(none — needs one)_"}`,
        )
        .join("\n")
    : "_No modules to consolidate. Add one with `add_module` first._";
  return renderTemplate("dream", { vars: { targets: list } });
}
