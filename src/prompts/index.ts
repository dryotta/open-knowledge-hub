import type { ResolvedContainer, ResolvedModule } from "../container/service.js";
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
    },
  });
}

export function buildHelp(question: string | undefined, resourceUris: string[]): Promise<string> {
  return renderTemplate("help", {
    vars: {
      question: question?.trim() || "Explain how to use Open Knowledge Hub effectively.",
      resources: resourceUris.map((uri) => `- \`${uri}\``).join("\n"),
    },
  });
}

/** Render a "dream" consolidation run: the consolidation discipline applied to the resolved target module(s). */
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
