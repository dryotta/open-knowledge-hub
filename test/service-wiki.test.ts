import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { saveRegistry, loadRegistry } from "../src/registry/registry.js";
import { okhVersion } from "../src/util/version.js";
import { makePaths, makeTempDir, testRun } from "./helpers.js";

class FakeGh {
  async currentLogin(): Promise<string> { return "tester"; }
}

const cleanups: string[] = [];
async function seed(backend: "git" | "local", origin?: string) {
  const home = await makeTempDir(); cleanups.push(home);
  const paths = makePaths(home);
  const clone = await makeTempDir(); cleanups.push(clone);
  await saveRegistry(paths, {
    version: 2,
    containers: [
      {
        name: "widgets",
        backend: { type: backend, config: origin ? { origin } : {} },
        localPath: clone,
        sync: { mode: "auto", config: {} },
        addedAt: new Date().toISOString(),
      },
    ],
  });
  const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
  return { paths, service, clone };
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const exists = (p: string) => stat(p).then(() => true).catch(() => false);

describe("setContainerWikiEnabled", () => {
  it("enable scaffolds workflow + config and flips the registry flag", async () => {
    const { service, paths, clone } = await seed("git", "https://github.com/acme/widgets.git");
    const res = await service.setContainerWikiEnabled("widgets", true);
    expect(res.changed).toBe(true);
    expect(res.entry.wiki).toEqual({ enabled: true });
    const wf = join(clone, ".github", "workflows", "okh-wiki.yml");
    expect(await exists(wf)).toBe(true);
    expect(await exists(join(clone, ".okh", "wiki.yml"))).toBe(true);
    const text = await readFile(wf, "utf8");
    expect(text).not.toContain("__OKH_VERSION__");
    expect(text).toContain(`open-knowledge-hub@${okhVersion()}`);
    expect((await loadRegistry(paths)).containers[0].wiki).toEqual({ enabled: true });
  });

  it("disable removes both files and clears the flag", async () => {
    const { service, clone } = await seed("git", "https://github.com/acme/widgets.git");
    await service.setContainerWikiEnabled("widgets", true);
    const res = await service.setContainerWikiEnabled("widgets", false);
    expect(res.entry.wiki).toEqual({ enabled: false });
    expect(await exists(join(clone, ".github", "workflows", "okh-wiki.yml"))).toBe(false);
    expect(await exists(join(clone, ".okh", "wiki.yml"))).toBe(false);
  });

  it("rejects a non-git container", async () => {
    const { service } = await seed("local");
    await expect(service.setContainerWikiEnabled("widgets", true)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects a non-github git origin", async () => {
    const { service } = await seed("git", "https://gitlab.com/acme/widgets.git");
    await expect(service.setContainerWikiEnabled("widgets", true)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
