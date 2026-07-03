import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// resources/ sits at the package root; ../../ from src/prompts (tsx dev) and
// dist/prompts (built) both resolve there.
const OKF_ROOT = new URL("../../resources/okf/", import.meta.url);
const DISCIPLINE_ROOT = new URL("../../resources/discipline/", import.meta.url);

export type OkfDoc = "OKF-FORMAT" | "okf-writer" | "okf-ask" | "okf-learn" | "okf-new-from-repo";
export type DisciplineDoc = "context" | "remember" | "reflect";

const cache = new Map<string, string>();

async function load(root: URL, name: string): Promise<string> {
  const key = `${root.href}${name}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const path = fileURLToPath(new URL(`${name}.md`, root));
  const text = await readFile(path, "utf8");
  cache.set(key, text);
  return text;
}

export function loadOkf(doc: OkfDoc): Promise<string> {
  return load(OKF_ROOT, doc);
}

export function loadDiscipline(doc: DisciplineDoc): Promise<string> {
  return load(DISCIPLINE_ROOT, doc);
}

export async function combineOkf(docs: OkfDoc[]): Promise<string> {
  const parts = await Promise.all(
    docs.map(async (d) => `<discipline name="${d}">\n\n${await loadOkf(d)}\n\n</discipline>`),
  );
  return parts.join("\n\n");
}
