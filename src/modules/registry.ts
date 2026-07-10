import type { Loader, ModuleType } from "./types.js";
import { isBuiltinType } from "./types.js";
import { knowledgeLoader } from "./loaders/knowledge.js";
import { skillsLoader } from "./loaders/skills.js";
import { toolsLoader } from "./loaders/tools.js";
import { memoryLoader } from "./loaders/memory.js";
import { projectLoader } from "./loaders/project.js";
import { llmwikiLoader } from "./loaders/llmwiki.js";
import { fileListingLoader } from "./loaders/file-listing.js";

const LOADERS: Record<ModuleType, Loader> = {
  knowledge: knowledgeLoader,
  skills: skillsLoader,
  tools: toolsLoader,
  memory: memoryLoader,
  project: projectLoader,
  llmwiki: llmwikiLoader,
};

const customLoader = fileListingLoader("custom", "Module");

/** Resolve a loader by type. Unknown/custom types use a generic file-listing loader. */
export function getLoader(type: string): Loader {
  return isBuiltinType(type) ? LOADERS[type] : customLoader;
}
