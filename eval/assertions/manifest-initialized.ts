import { join } from "node:path";
import { loadRegistry, findContainer } from "../../src/registry/registry.js";
import { loadContainerManifest } from "../../src/container/manifest.js";

interface Ctx {
  config?: { name?: string };
  providerResponse?: { metadata?: { okhHome?: string } };
}

/** Pass iff the registered container's manifest exists and parses. */
export default async function manifestInitialized(_output: string, context: Ctx) {
  const name = context.config?.name;
  const okhHome = context.providerResponse?.metadata?.okhHome;
  if (!name || !okhHome) return { pass: false, score: 0, reason: "missing config.name or metadata.okhHome" };
  const paths = { home: okhHome, containersDir: join(okhHome, "containers"), registryFile: join(okhHome, "registry.json"), preferencesFile: join(okhHome, "preferences.json") };
  const entry = findContainer(await loadRegistry(paths), name);
  if (!entry) return { pass: false, score: 0, reason: `no container "${name}"` };
  try {
    await loadContainerManifest(entry.localPath);
    return { pass: true, score: 1, reason: "manifest initialized" };
  } catch (err) {
    return { pass: false, score: 0, reason: `manifest missing/invalid: ${(err as Error).message}` };
  }
}
