import type { ResolvedContainer } from "../container/service.js";
import { combineOkf, loadDiscipline } from "./discipline.js";

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
  const discipline = await combineOkf(["okf-ask"]);
  return `# OKH: ask

**Question:** ${question ?? "(none provided — clarify with the user)"}

**Scan these targets:**
${renderTargets(targets)}

Answer using the \`okf-ask\` discipline: fork a fresh sub-agent that reads only the
relevant module(s), starting from each module's overview (knowledge: index.md;
skills/tools: the listing; memory/project: recent files). Return a distilled,
**cited** answer. Do not load whole modules into this context.

${discipline}`;
}

export async function buildContext(targets: ResolvedContainer[], task?: string): Promise<string> {
  const discipline = await loadDiscipline("context");
  return `# OKH: context

**Task:** ${task ?? "(none provided — clarify with the user)"}

**Available targets:**
${renderTargets(targets)}

<discipline name="context">

${discipline}

</discipline>`;
}

export async function buildLearn(targets: ResolvedContainer[], knowledge?: string): Promise<string> {
  const discipline = await combineOkf(["okf-learn", "okf-writer", "OKF-FORMAT"]);
  return `# OKH: learn

**Candidate knowledge:** ${knowledge ?? "(none provided — clarify with the user)"}

**Write into a knowledge module of:**
${renderTargets(targets)}

Fold the candidate knowledge into a \`knowledge\` module following the \`okf-learn\`
gate (default answer "no" unless it serves a goal) and the \`okf-writer\` discipline.

${WRITE_POLICY}

${discipline}`;
}

export async function buildRemember(targets: ResolvedContainer[], observation?: string): Promise<string> {
  const discipline = await loadDiscipline("remember");
  return `# OKH: remember

**Observation:** ${observation ?? "(none provided — clarify with the user)"}

**Record into a memory module of:**
${renderTargets(targets)}

<discipline name="remember">

${discipline}

</discipline>

${WRITE_POLICY}`;
}

export async function buildReflect(targets: ResolvedContainer[], focus?: string): Promise<string> {
  const discipline = await loadDiscipline("reflect");
  return `# OKH: reflect

**Focus:** ${focus ?? "(none — reflect broadly)"}

**Process memory/experience in:**
${renderTargets(targets)}

<discipline name="reflect">

${discipline}

</discipline>

${WRITE_POLICY}`;
}
