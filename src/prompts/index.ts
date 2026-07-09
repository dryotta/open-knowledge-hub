import type { ResolvedContainer, ResolvedModule } from "../container/service.js";
import { skillResourcePaths } from "../modules/shared.js";
import type { Skill } from "../modules/skills.js";
import { renderTemplate } from "./templates.js";

const NONE = "(none provided — clarify with the user)";

/** Render the target containers -> modules -> absolute paths as a markdown list. */
function renderTargets(targets: ResolvedContainer[]): string {
  if (targets.length === 0) return "_No containers are registered. Use the `add` tool first._";
  return targets
    .map((c) => {
      const header = `- **${c.name}** (${c.backend}, sync: ${c.sync}) — \`${c.root}\``;
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

export function buildRun(
  target: ResolvedContainer,
  module: ResolvedModule,
  skill: Skill,
  input?: string,
): Promise<string> {
  return renderTemplate("run", {
    vars: {
      skill: { name: skill.name, description: skill.description, body: skill.body },
      module: { type: module.type, name: module.name, path: module.path, absPath: module.absPath },
      container: { name: target.name, backend: target.backend, sync: String(target.sync), root: target.root },
      input: input ?? NONE,
    },
  });
}

export async function buildSharedRun(skill: Skill, input?: string): Promise<string> {
  return renderTemplate("shared-run", {
    vars: {
      skill: { name: skill.name, description: skill.description, body: skill.body },
      input: input ?? NONE,
      resources: renderResources(await skillResourcePaths(skill)),
    },
  });
}
