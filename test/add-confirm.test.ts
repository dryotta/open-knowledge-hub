import { describe, it, expect, afterEach } from "vitest";
import { rm, stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { loadRegistry } from "../src/registry/registry.js";
import { manifestExists } from "../src/container/manifest.js";
import { makePaths, makeTempDir, makeOrigin, testRun } from "./helpers.js";

class FakeGh {
  async createRepo(): Promise<string> { return "x"; }
  async createPr(): Promise<string> { return "x"; }
}

const cleanups: string[] = [];
async function setup() {
  const home = await makeTempDir(); cleanups.push(home);
  const paths = makePaths(home);
  const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
  return { paths, service };
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("addContainer preview/confirm", () => {
  it("previews (no side effects) for a non-existent folder without create", async () => {
    const { service, paths } = await setup();
    const target = join(paths.home, "new-hub"); // does not exist
    const out = await service.addContainer({ source: target, name: "new-hub" });
    expect(out.kind).toBe("plan");
    if (out.kind === "plan") {
      expect(out.plan.actions).toContain("create-folder");
      expect(out.plan.actions).toContain("init-manifest");
    }
    await expect(stat(target)).rejects.toBeTruthy(); // folder NOT created
    expect((await loadRegistry(paths)).containers).toHaveLength(0); // NOT registered
  });

  it("creates the folder + manifest + registers with create:true", async () => {
    const { service, paths } = await setup();
    const target = join(paths.home, "new-hub");
    const out = await service.addContainer({ source: target, name: "new-hub", create: true });
    expect(out.kind).toBe("applied");
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(await manifestExists(target)).toBe(true);
    expect((await loadRegistry(paths)).containers[0]!.name).toBe("new-hub");
  });
});
