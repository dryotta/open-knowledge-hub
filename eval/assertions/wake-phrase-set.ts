import { checkWakePhrase } from "./checks.js";

interface Ctx {
  config?: { default?: string };
  providerResponse?: { metadata?: { okhHome?: string } };
}

/** Pass iff preferences.json holds a wake phrase different from the default. */
export default async function wakePhraseSet(_output: string, context: Ctx) {
  const r = await checkWakePhrase(context.providerResponse?.metadata?.okhHome, context.config?.default ?? "hub");
  return { pass: r.pass, score: r.pass ? 1 : 0, reason: r.reason };
}
