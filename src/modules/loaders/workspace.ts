import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadModuleManifest } from "../manifest.js";
import type { Item, Loader } from "../types.js";
import { fileEtag } from "../../workspaces/files.js";
import {
  parseProjectReadme,
  parseWorkspaceReadme,
} from "../../workspaces/markdown.js";

async function enumerate(moduleRoot: string): Promise<Item[]> {
  const root = join(moduleRoot, "projects");
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const items: Item[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const readme = join(root, entry.name, "README.md");
    const info = await lstat(readme).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    try {
      const content = await readFile(readme, "utf8");
      const project = parseProjectReadme(entry.name, content, await fileEtag(readme));
      items.push({
        path: `projects/${entry.name}/README.md`,
        title: project.title,
        description: project.goal.split(/\r?\n/u)[0] ?? "",
        type: "project",
      });
    } catch {
      // Validation reports malformed projects; enumeration remains finite and useful.
    }
  }
  return items;
}

async function overview(moduleRoot: string): Promise<string> {
  const path = join(moduleRoot, "README.md");
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return "# Workspace\n\n_Run the initialize skill to add guidance and acceptance criteria._\n";
}

async function scaffold(moduleRoot: string): Promise<void> {
  await mkdir(join(moduleRoot, "projects"), { recursive: true });
}

async function validate(moduleRoot: string): Promise<string[]> {
  const issues: string[] = [];
  try {
    const manifest = await loadModuleManifest(moduleRoot);
    const lead = manifest.config?.lead;
    const agents = manifest.config?.agents;
    if (typeof lead !== "string" || lead.trim().length === 0) {
      issues.push(".okh/module.yaml: workspace config requires a non-empty lead");
    }
    if (
      agents !== undefined
      && (!Array.isArray(agents) || agents.some((agent) => typeof agent !== "string" || !agent.trim()))
    ) {
      issues.push(".okh/module.yaml: agents must be an array of non-empty references");
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const workspaceReadme = join(moduleRoot, "README.md");
  try {
    const content = await readFile(workspaceReadme, "utf8");
    parseWorkspaceReadme(content, await fileEtag(workspaceReadme), "Workspace");
  } catch (error) {
    issues.push(`README.md: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = join(moduleRoot, "projects");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      issues.push(`projects/${entry.name}: project entries must be regular directories`);
      continue;
    }
    const readme = join(root, entry.name, "README.md");
    try {
      const content = await readFile(readme, "utf8");
      parseProjectReadme(entry.name, content, await fileEtag(readme));
    } catch (error) {
      issues.push(`projects/${entry.name}/README.md: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return issues;
}

export const workspaceLoader: Loader = {
  enumerate,
  overview,
  requiredFiles: ["README.md"],
  scaffold,
  validate,
};
