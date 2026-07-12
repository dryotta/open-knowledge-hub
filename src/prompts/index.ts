import type { ResolvedContainer, ResolvedModule } from "../container/service.js";
import { skillResourcePaths } from "../modules/shared.js";
import type { Skill } from "../modules/skills.js";
import { renderTemplate } from "./templates.js";
import { formatSyncDescriptor } from "../util/syncFormat.js";

const NONE = "(none provided — clarify with the user)";

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

/** Render a skill's resource paths block (empty when there are none). */
function renderResources(paths: string[]): string {
  if (paths.length === 0) return "";
  return `**Skill resources (open as needed):**\n${paths.map((p) => `- \`${p}\``).join("\n")}`;
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

/** Render a skill run. With target+module it's a module skill; with neither, a module-less shared skill. */
export async function buildRun(
  skill: Skill,
  input?: string,
  target?: ResolvedContainer,
  module?: ResolvedModule,
): Promise<string> {
  const targetBlock =
    target && module
      ? `**Module:** ${module.type} · ${module.name} (\`${module.path}\`) → \`${module.absPath}\`\n` +
        `**Container:** ${target.name} (${target.backend}, sync: ${formatSyncDescriptor(target.sync)}) — \`${target.root}\`\n`
      : "";
  return renderTemplate("run", {
    vars: {
      skill: { name: skill.name, description: skill.description, body: skill.body },
      input: input ?? NONE,
      target: targetBlock,
      resources: renderResources(await skillResourcePaths(skill)),
    },
  });
}
