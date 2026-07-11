import { join, basename } from "node:path";
import { stat } from "node:fs/promises";
import { readTree, diffTrees } from "./_compare.js";
import { parseFrontmatter, stringField } from "../../src/util/frontmatter.js";
import { llmwikiLoader } from "../../src/modules/loaders/llmwiki.js";

interface Config {
  module?: string;
  requiredIndexText?: string[];
  requiredGroupIndexes?: string[];
  noContentPages?: boolean;
  expectedNewPage?: { folder: string; type: string; terms: string[] };
  requireIndexAndLogChanged?: boolean;
  requireCleanHealth?: boolean;
}

interface Ctx {
  config?: Config;
  providerResponse?: { metadata?: { containerPath?: string; fixtureDir?: string } };
}

const RESERVED_BASENAMES = new Set(["index.md", "log.md"]);

function isContentPage(relPath: string): boolean {
  return relPath.endsWith(".md") && !RESERVED_BASENAMES.has(basename(relPath));
}

export default async function llmwikiState(_output: string, context: Ctx) {
  const meta = context.providerResponse?.metadata ?? {};
  const config = context.config ?? {};
  const module = config.module ?? "wiki";

  if (!meta.containerPath || !meta.fixtureDir) {
    return { pass: false, score: 0, reason: "missing containerPath/fixtureDir in metadata" };
  }

  const moduleRoot = join(meta.containerPath, module);
  const fixtureRoot = join(meta.fixtureDir, module);
  const problems: string[] = [];

  const afterTree = await readTree(moduleRoot);
  const beforeTree = await readTree(fixtureRoot);
  const diff = diffTrees(beforeTree, afterTree);

  // --- Initialization validation ---

  // Check module index exists and includes requiredIndexText terms
  if (config.requiredIndexText && config.requiredIndexText.length > 0) {
    const indexContent = afterTree.get("index.md");
    if (!indexContent) {
      problems.push("module index.md does not exist");
    } else {
      const lower = indexContent.toLowerCase();
      for (const term of config.requiredIndexText) {
        if (!lower.includes(term.toLowerCase())) {
          problems.push(`index.md missing required text: "${term}"`);
        }
      }
    }
  }

  // Check requiredGroupIndexes exist (as directories or files in the module)
  if (config.requiredGroupIndexes && config.requiredGroupIndexes.length > 0) {
    for (const rel of config.requiredGroupIndexes) {
      const normalized = rel.replace(/\\/g, "/");
      const fullPath = join(moduleRoot, normalized);
      try {
        await stat(fullPath);
      } catch {
        problems.push(`required group index path not found: "${rel}"`);
      }
    }
  }

  // Check noContentPages: reject any content page in the after tree
  if (config.noContentPages) {
    const contentPages = [...afterTree.keys()].filter(isContentPage);
    if (contentPages.length > 0) {
      problems.push(`found content page(s) when none expected: ${contentPages.join(", ")}`);
    }
  }

  // --- Write validation ---

  if (config.expectedNewPage) {
    const { folder, type, terms } = config.expectedNewPage;
    const folderPrefix = folder.replace(/\\/g, "/") + "/";

    // Only ADDED markdown content pages under the configured folder
    const addedInFolder = diff.added.filter(
      (p) => p.startsWith(folderPrefix) && isContentPage(p),
    );

    if (addedInFolder.length === 0) {
      problems.push(`no added content pages under "${folder}"`);
    } else {
      let matched = false;
      const pageProblems: string[] = [];

      for (const rel of addedInFolder) {
        const content = afterTree.get(rel);
        if (!content) continue;

        const { data, body } = parseFrontmatter(content);
        const pageType = stringField(data, "type");
        const title = stringField(data, "title") ?? "";

        if (pageType !== type) {
          pageProblems.push(`${rel}: type is "${pageType ?? "(missing)"}" expected "${type}"`);
          continue;
        }

        // Check terms case-insensitively across title + body
        const searchText = (title + "\n" + body).toLowerCase();
        const missingTerms = terms.filter((t) => !searchText.includes(t.toLowerCase()));
        if (missingTerms.length > 0) {
          pageProblems.push(`${rel}: missing terms [${missingTerms.join(", ")}]`);
          continue;
        }

        matched = true;
        break;
      }

      if (!matched) {
        problems.push(...pageProblems);
      }
    }
  }

  // requireIndexAndLogChanged: changed or added paths must include index.md and log.md
  if (config.requireIndexAndLogChanged) {
    const changedOrAdded = new Set([...diff.changed, ...diff.added]);
    if (!changedOrAdded.has("index.md")) {
      problems.push("index.md was not changed or added");
    }
    if (!changedOrAdded.has("log.md")) {
      problems.push("log.md was not changed or added");
    }
  }

  // requireCleanHealth: all four health arrays must be empty
  if (config.requireCleanHealth) {
    const h = await llmwikiLoader.health!(moduleRoot);
    if (h.orphans.length > 0) problems.push(`health: orphans [${h.orphans.join(", ")}]`);
    if (h.danglingLinks.length > 0) problems.push(`health: dangling links [${h.danglingLinks.map((l) => `${l.from}->${l.to}`).join(", ")}]`);
    if (h.uncataloged.length > 0) problems.push(`health: uncataloged [${h.uncataloged.join(", ")}]`);
    if (h.missingType.length > 0) problems.push(`health: missing type [${h.missingType.join(", ")}]`);
  }

  const pass = problems.length === 0;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass ? `llmwiki ${module} valid` : problems.join("; "),
  };
}
