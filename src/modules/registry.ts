import type { Loader, ModuleType } from "./types.js";
import { knowledgeLoader } from "./loaders/knowledge.js";
import { skillsLoader } from "./loaders/skills.js";
import { toolsLoader } from "./loaders/tools.js";
import { memoryLoader } from "./loaders/memory.js";
import { projectLoader } from "./loaders/project.js";

const LOADERS: Record<ModuleType, Loader> = {
  knowledge: knowledgeLoader,
  skills: skillsLoader,
  tools: toolsLoader,
  memory: memoryLoader,
  project: projectLoader,
};

/** Resolve the deterministic loader for a module type. */
export function getLoader(type: ModuleType): Loader {
  return LOADERS[type];
}
