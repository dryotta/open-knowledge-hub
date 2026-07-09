import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// resources/ sits at the package root; ../../ from src/prompts (tsx dev) and
// dist/prompts (built) both resolve there.
const PROMPTS_ROOT = new URL("../../resources/prompts/", import.meta.url);

export type PromptDoc = "ask" | "context" | "onboard";

const cache = new Map<string, string>();

/** Load a flow prompt body (ask/context/onboard) from resources/prompts/. */
export async function loadPrompt(doc: PromptDoc): Promise<string> {
  const cached = cache.get(doc);
  if (cached) return cached;
  const path = fileURLToPath(new URL(`${doc}.md`, PROMPTS_ROOT));
  const text = await readFile(path, "utf8");
  cache.set(doc, text);
  return text;
}
