import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Loader for the vendored OKF discipline documents.
 *
 * The markdown lives under `resources/okf/` at the package root and is copied into
 * the published npm tarball (see package.json `files`). Resolving relative to
 * `import.meta.url` works both from `src/` (tsx dev) and `dist/` (built), since the
 * depth to the package root is the same.
 */
const RESOURCE_ROOT = new URL("../../resources/okf/", import.meta.url);

export type DisciplineDoc =
  | "OKF-FORMAT"
  | "okf-writer"
  | "okf-ask"
  | "okf-learn"
  | "okf-new-from-repo";

const cache = new Map<DisciplineDoc, string>();

export async function loadDiscipline(doc: DisciplineDoc): Promise<string> {
  const cached = cache.get(doc);
  if (cached) return cached;
  const path = fileURLToPath(new URL(`${doc}.md`, RESOURCE_ROOT));
  const text = await readFile(path, "utf8");
  cache.set(doc, text);
  return text;
}

async function combine(docs: DisciplineDoc[]): Promise<string> {
  const parts = await Promise.all(
    docs.map(async (d) => `<discipline name="${d}">\n\n${await loadDiscipline(d)}\n\n</discipline>`),
  );
  return parts.join("\n\n");
}

/** Shared header describing the concrete pack the flow operates on. */
function packHeader(fields: Record<string, string | undefined>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `- **${k}**: ${v}`);
  return lines.join("\n");
}

/** The mandatory write policy shared by learn / review_update. */
const WRITE_POLICY = `## How to apply changes (OKH write policy)

Changes to a pack are published as a **pull request** — never a direct push.

1. Start a change branch with the \`pack_begin_change\` tool ({ slug, topic }); it returns the
   pack's local path and creates branch \`okh/<slug>/<topic>\`.
2. Edit the pack files at that local path, following the disciplines above.
3. **Summarise the diff for the user and get explicit confirmation** before committing. Use
   \`pack_status\` / \`pack_diff\` to show what changed.
4. On approval: \`pack_commit\` ({ slug, message }), then \`pack_open_pr\`
   ({ slug, title, body }). Surface the returned PR URL to the user.

Never call \`pack_commit\`/\`pack_open_pr\` without the user's explicit go-ahead.`;

export interface AskFlowContext {
  slug: string;
  localPath: string;
  question?: string;
}

export async function buildAskFlow(ctx: AskFlowContext): Promise<string> {
  const discipline = await combine(["okf-ask"]);
  return `# OKH flow: ask "${ctx.slug}"

${packHeader({ slug: ctx.slug, "pack path": ctx.localPath, question: ctx.question })}

Answer the question(s) from the knowledge pack at the path above, following the \`okf-ask\`
discipline: fork a fresh sub-agent that reads only that pack (start from its \`index.md\`) and
returns a distilled, cited answer. Do not load the whole pack into this context. If the pack is
not installed, install it first with the \`pack_install\` tool.

${discipline}`;
}

export interface LearnFlowContext {
  slug: string;
  localPath: string;
  knowledge?: string;
}

export async function buildLearnFlow(ctx: LearnFlowContext): Promise<string> {
  const discipline = await combine(["okf-learn", "okf-writer", "OKF-FORMAT"]);
  return `# OKH flow: learn into "${ctx.slug}"

${packHeader({ slug: ctx.slug, "pack path": ctx.localPath, "candidate knowledge": ctx.knowledge })}

Fold the candidate knowledge into the pack at the path above, following the \`okf-learn\` gate
(default answer is "no" unless it serves a goal) and the \`okf-writer\` authoring discipline.

${WRITE_POLICY}

${discipline}`;
}

export interface ReviewFlowContext {
  slug: string;
  localPath: string;
  focus?: string;
}

export async function buildReviewUpdateFlow(ctx: ReviewFlowContext): Promise<string> {
  const discipline = await combine(["okf-learn", "okf-writer", "OKF-FORMAT"]);
  return `# OKH flow: review & update "${ctx.slug}"

${packHeader({ slug: ctx.slug, "pack path": ctx.localPath, focus: ctx.focus })}

Review the pack at the path above against its scope contract (goals + target questions +
out-of-scope in \`index.md\`). Identify staleness, gaps, and drift versus the cited sources; then
apply the smallest set of updates that keeps it correct and tight. Prune anything no longer
serving a target question. Use the \`okf-writer\` discipline for any edits and the \`okf-learn\`
gate for any net-new knowledge.

${WRITE_POLICY}

${discipline}`;
}

export interface CreateFlowContext {
  slug?: string;
  sourceRepo?: string;
}

export async function buildCreateFlow(ctx: CreateFlowContext): Promise<string> {
  const discipline = await combine(["okf-new-from-repo", "okf-writer", "OKF-FORMAT"]);
  return `# OKH flow: create a new pack${ctx.slug ? ` ("${ctx.slug}")` : ""}

${packHeader({ "proposed slug": ctx.slug, "source repo": ctx.sourceRepo })}

Author a brand-new knowledge pack following \`okf-new-from-repo\`: grill the scope contract, explore
only what the target questions demand, then write the OKF bundle.

## How to scaffold & publish (OKH create policy)

1. Once you and the user agree the slug, call the \`pack_create\` tool ({ slug, title?,
   description? }); it scaffolds a local pack (with a skeleton \`index.md\` under the
   \`knowledge/\` subfolder, leaving the repo root free for \`README.md\`/\`LICENSE\`),
   \`git init\`s it, and returns the local path.
2. Author the bundle at that path per the disciplines below. Fill in the scope contract first.
3. When the user approves the initial content, publish with the \`pack_publish\` tool
   ({ slug, repoName, visibility, description? }). This is the one direct-to-\`main\` push. All
   later edits go through the PR write flow (learn / review_update).

${discipline}`;
}
