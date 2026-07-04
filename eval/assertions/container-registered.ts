import { checkContainer } from "./checks.js";

interface Ctx {
  config?: { name?: string; backend?: string; module?: string };
  providerResponse?: { metadata?: { okhHome?: string } };
}

/** Pass iff the expected container is registered with a valid manifest (and optional module). */
export default async function containerRegistered(_output: string, context: Ctx) {
  const r = await checkContainer(context.providerResponse?.metadata?.okhHome, {
    ...(context.config?.name ? { name: context.config.name } : {}),
    ...(context.config?.backend ? { backend: context.config.backend } : {}),
    ...(context.config?.module ? { module: context.config.module } : {}),
  });
  return { pass: r.pass, score: r.pass ? 1 : 0, reason: r.reason };
}
