import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { resolvePaths } from "../src/config.js";
import { saveModuleManifest } from "../src/modules/manifest.js";
import { saveRegistry } from "../src/registry/registry.js";

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "okh-home-"));
  const root = await mkdtemp(join(tmpdir(), "okh-c-"));
  const paths = resolvePaths({ OKH_HOME: home });
  await saveRegistry(paths, {
    version: 1,
    containers: [{ name: "h", backend: "local", localPath: root, sync: "auto", addedAt: new Date().toISOString() }],
  });
  return { root, svc: new ContainerService(paths) };
}

describe("inspect surfaces llmwiki health", () => {
  it("returns a health block with orphans for an llmwiki module", async () => {
    const { root, svc } = await setup();
    const mod = join(root, "wiki");
    await saveModuleManifest(mod, { type: "llmwiki", name: "Wiki", description: "" });
    await writeFile(join(mod, "index.md"), "# Wiki\n", "utf8");
    await mkdir(join(mod, "concepts"), { recursive: true });
    await writeFile(join(mod, "concepts", "orphan.md"), "---\ntype: concept\ntitle: Orphan\n---\nalone\n", "utf8");

    const result = await svc.inspect("h", "wiki");
    if (result.kind !== "module") throw new Error("expected module result");
    expect(result.health?.orphans).toContain("concepts/orphan.md");
  });
});
