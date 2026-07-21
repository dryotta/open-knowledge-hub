import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { OkhError } from "../errors.js";
import type {
  ProjectRecord,
  WorkspacePatch,
  WorkspaceReadme,
} from "./types.js";

const FRONTMATTER_RE = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const PROJECT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

const projectFrontmatterSchema = z.object({
  title: z.string().trim().min(1),
  status: z.enum(["active", "archived"]),
  createdAt: z.string().regex(ISO_RE),
  updatedAt: z.string().regex(ISO_RE),
  activeRun: z.string().min(1).nullable(),
  result: z.string().min(1).nullable(),
  targetDate: z.string().regex(DATE_RE).optional(),
  tags: z.array(z.string().regex(TAG_RE)).optional(),
}).strict();

interface SectionRange {
  start: number;
  contentStart: number;
  end: number;
}

function splitFrontmatter(content: string): {
  yaml: string;
  body: string;
  prefixLength: number;
} {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    throw new OkhError("INVALID_MANIFEST", "Project README must start with YAML frontmatter.");
  }
  return {
    yaml: match[1]!,
    body: content.slice(match[0].length),
    prefixLength: match[0].length,
  };
}

function recordFromYaml(yaml: string, file: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseYaml(yaml);
  } catch {
    throw new OkhError("INVALID_MANIFEST", `${file} has invalid YAML frontmatter.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OkhError("INVALID_MANIFEST", `${file} frontmatter must be a mapping.`);
  }
  return value as Record<string, unknown>;
}

function headingRange(body: string, heading: string): SectionRange | undefined {
  const lines: Array<{ start: number; text: string; lineEnding: string }> = [];
  for (const match of body.matchAll(/([^\r\n]*)(\r\n|\n|$)/gu)) {
    if (!match[0]) break;
    lines.push({
      start: match.index,
      text: match[1]!,
      lineEnding: match[2]!,
    });
  }
  const target = `## ${heading}`.toLowerCase();
  const startLine = lines.findIndex((line) => line.text.trim().toLowerCase() === target);
  if (startLine < 0) return undefined;
  let endLine = lines.length;
  for (let index = startLine + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index]!.text)) {
      endLine = index;
      break;
    }
  }
  const line = lines[startLine]!;
  const headingEnd = line.start + line.text.length;
  return {
    start: line.start,
    contentStart: headingEnd + line.lineEnding.length,
    end: endLine < lines.length ? lines[endLine]!.start : body.length,
  };
}

export function markdownSection(body: string, heading: string): string | undefined {
  const range = headingRange(body, heading);
  return range ? body.slice(range.contentStart, range.end).trim() : undefined;
}

function replaceSection(body: string, heading: string, value: string | null): string {
  const range = headingRange(body, heading);
  const normalized = value?.trim() ?? "";
  if (range) {
    if (!normalized) {
      return `${body.slice(0, range.start).trimEnd()}\n${body.slice(range.end).trimStart()}`.trimEnd() + "\n";
    }
    return `${body.slice(0, range.contentStart)}\n${normalized}\n\n${body.slice(range.end).trimStart()}`.trimEnd() + "\n";
  }
  if (!normalized) return body.trimEnd() + "\n";
  return `${body.trimEnd()}\n\n## ${heading}\n\n${normalized}\n`;
}

function bullets(values: readonly string[]): string {
  return values.map((value) => `- ${value.trim()}`).join("\n");
}

export function acceptanceFromMarkdown(body: string): string[] {
  const section = markdownSection(body, "Acceptance");
  if (!section) return [];
  return section
    .split(/\r?\n/u)
    .filter((line) => /^-\s+\S/u.test(line))
    .map((line) => line.replace(/^-\s+/u, "").trim())
    .filter(Boolean);
}

function firstHeading(content: string, fallback: string): string {
  const match = /^#\s+(.+)$/mu.exec(content);
  return match?.[1]?.trim() || fallback;
}

export function validateProjectId(id: string): void {
  if (!PROJECT_ID_RE.test(id)) {
    throw new OkhError(
      "INVALID_ARGUMENT",
      "project must be a lowercase kebab-case ID.",
    );
  }
}

export function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const normalized = [...new Set(tags.map((tag) => tag.trim().toLowerCase()))].sort();
  if (normalized.some((tag) => !TAG_RE.test(tag))) {
    throw new OkhError("INVALID_ARGUMENT", "tags must be lowercase kebab-case values.");
  }
  return normalized;
}

export function validateTargetDate(value: string | undefined): void {
  if (value !== undefined && !DATE_RE.test(value)) {
    throw new OkhError("INVALID_ARGUMENT", "targetDate must use YYYY-MM-DD.");
  }
}

export function validateAcceptance(values: readonly string[], required: boolean): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (required && normalized.length === 0) {
    throw new OkhError("INVALID_ARGUMENT", "Workspace acceptance requires at least one criterion.");
  }
  if (normalized.some((value) => value.includes("\n"))) {
    throw new OkhError("INVALID_ARGUMENT", "Acceptance criteria must each fit on one line.");
  }
  return normalized;
}

export function parseWorkspaceReadme(
  content: string,
  etag: string,
  fallbackTitle: string,
): WorkspaceReadme {
  const acceptance = acceptanceFromMarkdown(content);
  validateAcceptance(acceptance, true);
  return {
    title: firstHeading(content, fallbackTitle),
    guidance: markdownSection(content, "Working guidance") ?? "",
    acceptance,
    content,
    etag,
  };
}

export function parseProjectReadme(
  id: string,
  content: string,
  etag: string,
): ProjectRecord {
  validateProjectId(id);
  const { yaml, body } = splitFrontmatter(content);
  const parsed = projectFrontmatterSchema.safeParse(recordFromYaml(yaml, `${id}/README.md`));
  if (!parsed.success) {
    throw new OkhError(
      "INVALID_MANIFEST",
      `${id}/README.md frontmatter is invalid: ${parsed.error.issues[0]?.message ?? parsed.error.message}`,
    );
  }
  const goal = markdownSection(body, "Goal")?.trim();
  if (!goal) {
    throw new OkhError("INVALID_MANIFEST", `${id}/README.md requires a non-empty ## Goal section.`);
  }
  return {
    id,
    ...parsed.data,
    tags: normalizeTags(parsed.data.tags),
    goal,
    guidance: markdownSection(body, "Guidance")?.trim() || undefined,
    acceptance: acceptanceFromMarkdown(body),
    content,
    etag,
  };
}

export function createWorkspaceReadme(
  title: string,
  guidance: string | undefined,
  acceptance: readonly string[] | undefined,
): string {
  const criteria = validateAcceptance(acceptance ?? [], true);
  const guidanceText = guidance?.trim() || "Describe how work in this workspace should be performed.";
  return [
    `# ${title.trim() || "Workspace"}`,
    "",
    "## Working guidance",
    "",
    guidanceText,
    "",
    "## Acceptance",
    "",
    bullets(criteria),
    "",
  ].join("\n");
}

export function createProjectReadme(input: {
  title: string;
  goal: string;
  createdAt: string;
  guidance?: string;
  acceptance?: string[];
  targetDate?: string;
  tags?: string[];
}): string {
  const title = input.title.trim();
  const goal = input.goal.trim();
  if (!title || !goal) {
    throw new OkhError("INVALID_ARGUMENT", "Project title and goal are required.");
  }
  validateTargetDate(input.targetDate);
  const tags = normalizeTags(input.tags);
  const frontmatter: Record<string, unknown> = {
    title,
    status: "active",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    activeRun: null,
    result: null,
  };
  if (input.targetDate) frontmatter.targetDate = input.targetDate;
  if (tags.length > 0) frontmatter.tags = tags;
  const sections = [
    "---",
    stringifyYaml(frontmatter).trimEnd(),
    "---",
    "",
    "## Goal",
    "",
    goal,
  ];
  if (input.guidance?.trim()) {
    sections.push("", "## Guidance", "", input.guidance.trim());
  }
  const acceptance = validateAcceptance(input.acceptance ?? [], false);
  if (acceptance.length > 0) {
    sections.push("", "## Acceptance", "", bullets(acceptance));
  }
  return `${sections.join("\n")}\n`;
}

function patchFrontmatter(
  content: string,
  patch: Record<string, unknown>,
): { body: string; content: string } {
  const split = splitFrontmatter(content);
  const document = parseDocument(split.yaml);
  if (document.errors.length > 0) {
    throw new OkhError("INVALID_MANIFEST", "Project README frontmatter is not valid YAML.");
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null && (key === "targetDate" || key === "tags")) document.delete(key);
    else document.set(key, value);
  }
  const yaml = document.toString({ lineWidth: 0 }).trimEnd();
  return {
    body: split.body,
    content: `---\n${yaml}\n---\n${split.body}`,
  };
}

export function patchProjectReadme(
  project: ProjectRecord,
  patch: WorkspacePatch & {
    status?: "active" | "archived";
    activeRun?: string | null;
    result?: string | null;
    updatedAt: string;
  },
): string {
  if (patch.title !== undefined && !patch.title.trim()) {
    throw new OkhError("INVALID_ARGUMENT", "title cannot be empty.");
  }
  validateTargetDate(patch.targetDate ?? undefined);
  const tags = patch.tags === undefined ? undefined : normalizeTags(patch.tags);
  const frontmatter = patchFrontmatter(project.content, {
    title: patch.title?.trim(),
    status: patch.status,
    updatedAt: patch.updatedAt,
    activeRun: patch.activeRun,
    result: patch.result,
    targetDate: patch.targetDate,
    tags: tags && tags.length > 0 ? tags : tags === undefined ? undefined : null,
  });
  let body = frontmatter.body;
  if (patch.goal !== undefined) {
    if (!patch.goal.trim()) throw new OkhError("INVALID_ARGUMENT", "goal cannot be empty.");
    body = replaceSection(body, "Goal", patch.goal);
  }
  if (patch.guidance !== undefined) {
    body = replaceSection(body, "Guidance", patch.guidance);
  }
  if (patch.acceptance !== undefined) {
    const criteria = validateAcceptance(patch.acceptance, false);
    body = replaceSection(body, "Acceptance", criteria.length > 0 ? bullets(criteria) : null);
  }
  const split = splitFrontmatter(frontmatter.content);
  return `${frontmatter.content.slice(0, split.prefixLength)}${body.trimStart()}`.trimEnd() + "\n";
}

export function patchWorkspaceReadme(
  workspace: WorkspaceReadme,
  patch: Pick<WorkspacePatch, "guidance" | "acceptance">,
): string {
  let content = workspace.content;
  if (patch.guidance !== undefined) {
    content = replaceSection(content, "Working guidance", patch.guidance);
  }
  if (patch.acceptance !== undefined) {
    const criteria = validateAcceptance(patch.acceptance, true);
    content = replaceSection(content, "Acceptance", bullets(criteria));
  }
  return content.trimEnd() + "\n";
}
