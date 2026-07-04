import { checkManifest } from "./checks.js";

interface Ctx {
  config?: { name?: string };
  providerResponse?: { metadata?: { okhHome?: string } };
}

/** Pass iff the registered container's manifest exists and parses. */
export default async function manifestInitialized(_output: string, context: Ctx) {
  const r = await checkManifest(context.providerResponse?.metadata?.okhHome, context.config?.name);
  return { pass: r.pass, score: r.pass ? 1 : 0, reason: r.reason };
}
