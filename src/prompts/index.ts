import type { ResolvedContainer, ResolvedModule } from "../container/service.js";
import { skillResourcePaths } from "../modules/shared.js";
import type { Skill } from "../modules/skills.js";
import { loadPrompt } from "./prompts.js";

const WRITE_POLICY = `## Write policy

After editing files:
1. Summarise the diff for the user and get explicit confirmation before persisting.
2. Call the \`sync\` tool ({ container }). It commits + pushes directly (sync: auto)
   or opens a pull request (sync: pr), per the container's configuration.
Never persist changes without the user's go-ahead. If several candidate
containers/modules are listed below, choose or confirm ONE target before writing.`;

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

export async function buildAsk(targets: ResolvedContainer[], question?: string): Promise<string> {
  const discipline = await loadPrompt("ask");
  return `# OKH: ask

**Question:** ${question ?? "(none provided — clarify with the user)"}

**Scan these targets:**
${renderTargets(targets)}

Answer using the \`ask\` discipline: fork a fresh sub-agent that reads only the
relevant module(s), starting from each module's overview (knowledge: index.md;
skills/tools: the listing; memory/project: recent files). Return a distilled,
**cited** answer. Do not load whole modules into this context.

<discipline name="ask">

${discipline}

</discipline>`;
}

export async function buildContext(targets: ResolvedContainer[], task?: string): Promise<string> {
  const discipline = await loadPrompt("context");
  return `# OKH: context

**Task:** ${task ?? "(none provided — clarify with the user)"}

**Available targets:**
${renderTargets(targets)}

<discipline name="context">

${discipline}

</discipline>`;
}

export function buildRun(target: ResolvedContainer, module: ResolvedModule, skill: Skill, input?: string): string {
  return `# OKH: run — ${skill.name}

**Skill:** ${skill.name} — ${skill.description}
**Module:** ${module.type} · ${module.name} (\`${module.path}\`) → \`${module.absPath}\`
**Container:** ${target.name} (${target.backend}, sync: ${target.sync}) — \`${target.root}\`
**Input:** ${input ?? "(none provided — clarify with the user)"}

<discipline name="${skill.name}">

${skill.body}

</discipline>

${WRITE_POLICY}`;
}

export async function buildSharedRun(skill: Skill, input?: string): Promise<string> {
  const resources = await skillResourcePaths(skill);
  const resourceBlock = resources.length
    ? `\n**Skill resources (open as needed):**\n${resources.map((p) => `- \`${p}\``).join("\n")}\n`
    : "";
  return `# OKH: run — ${skill.name} (shared)

**Skill:** ${skill.name} — ${skill.description}
**Input:** ${input ?? "(none provided — clarify with the user)"}
${resourceBlock}
<discipline name="${skill.name}">

${skill.body}

</discipline>`;
}

export async function buildOnboard(targets: ResolvedContainer[], wakePhrase: string): Promise<string> {
  const discipline = await loadPrompt("onboard");
  return `# OKH: onboard

**Wake phrase:** \`${wakePhrase}\`

**Current containers:**
${renderTargets(targets)}

<discipline name="onboard">

${discipline}

</discipline>`;
}
