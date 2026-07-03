import { join } from "node:path";
import { readFile } from "node:fs/promises";

interface Ctx {
  config?: { default?: string };
  providerResponse?: { metadata?: { okhHome?: string } };
}

/** Pass iff preferences.json holds a wake phrase different from the default. */
export default async function wakePhraseSet(_output: string, context: Ctx) {
  const okhHome = context.providerResponse?.metadata?.okhHome;
  const def = context.config?.default ?? "hub";
  if (!okhHome) return { pass: false, score: 0, reason: "missing metadata.okhHome" };
  try {
    const prefs = JSON.parse(await readFile(join(okhHome, "preferences.json"), "utf8")) as { wakePhrase?: string };
    if (prefs.wakePhrase && prefs.wakePhrase !== def) {
      return { pass: true, score: 1, reason: `wake phrase set to "${prefs.wakePhrase}"` };
    }
    return { pass: false, score: 0, reason: `wake phrase unchanged (${prefs.wakePhrase ?? "none"})` };
  } catch {
    return { pass: false, score: 0, reason: "preferences.json not written" };
  }
}
