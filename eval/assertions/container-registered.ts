import { join } from "node:path";
import { loadRegistry, findContainer } from "../../src/registry/registry.js";
import { loadContainerManifest } from "../../src/container/manifest.js";

interface Ctx {
  config?: { name?: string; backend?: string; module?: string };
  providerResponse?: { metadata?: { okhHome?: string } };
}

/** Pass iff the expected container is registered with a valid manifest (and optional module). */
export default async function containerRegistered(_output: string, context: Ctx) {
  const name = context.config?.name;
  const okhHome = context.providerResponse?.metadata?.okhHome;
  if (!name || !okhHome) return { pass: false, score: 0, reason: "missing config.name or metadata.okhHome" };
  const paths = { home: okhHome, containersDir: join(okhHome, "containers"), registryFile: join(okhHome, "registry.json"), preferencesFile: join(okhHome, "preferences.json") };
  const reg = await loadRegistry(paths);
  const entry = findContainer(reg, name);
  if (!entry) return { pass: false, score: 0, reason: `no container "${name}" was registered` };
  if (context.config?.backend && entry.backend !== context.config.backend) {
    return { pass: false, score: 0, reason: `backend ${entry.backend} != expected ${context.config.backend}` };
  }
  try {
    const manifest = await loadContainerManifest(entry.localPath);
    if (context.config?.module && !manifest.modules.some((m) => m.path === context.config!.module)) {
      return { pass: false, score: 0, reason: `module "${context.config.module}" not present` };
    }
  } catch (err) {
    return { pass: false, score: 0, reason: `invalid manifest: ${(err as Error).message}` };
  }
  return { pass: true, score: 1, reason: `container "${name}" registered [${entry.backend}]` };
}
