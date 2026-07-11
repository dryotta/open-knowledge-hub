import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { makePaths, makeTempDir, makeOrigin, testRun } from "./helpers.js";

class FakeGh {
  async createRepo(): Promise<string> { return "x"; }
  async createPr(): Promise<string> { return "https://github.com/test/x/pull/1"; }
}

const cleanups: string[] = [];

async function checkoutOrigin(bare: string): Promise<string> {
  const dest = await makeTempDir("okh-verify-");
  cleanups.push(dest);
  await testRun("git", ["clone", bare, dest]);
  return dest;
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("end-to-end", () => {
  it("git container: add -> add module -> author -> sync -> inspect", async () => {
    const home = await makeTempDir();
    cleanups.push(home);
    const origin = await makeOrigin();
    const service = new ContainerService(makePaths(home), new Git(testRun), new FakeGh() as unknown as Gh);

    const addContainer = await service.addContainer({ source: origin, name: "hub", create: true });
    if (addContainer.kind !== "applied") throw new Error("expected applied");
    const entry = addContainer.entry;
    const addModule = await service.addModule({ container: "hub", path: "kb", type: "knowledge", name: "KB", create: true });
    if (addModule.kind !== "applied") throw new Error("expected applied");
    const { moduleRoot } = addModule;
    await writeFile(join(moduleRoot, "auth.md"), "---\ntitle: Auth\ndescription: Login\ntype: Flow\n---\nbody", "utf8");

    const [res] = await service.sync("hub");
    expect(res!.action).toBe("committed-pushed");
    expect(res!.validation.ok).toBe(true);

    const verify = await checkoutOrigin(origin);
    expect((await stat(join(verify, "kb", ".okh", "module.yaml"))).isFile()).toBe(true);
    expect((await stat(join(verify, "kb", "auth.md"))).isFile()).toBe(true);

    const inspected = await service.inspect("hub", "kb");
    expect(inspected.kind).toBe("module");
    if (inspected.kind === "module") {
      expect(inspected.items.map((i) => i.title)).toContain("Auth");
    }
    expect(entry.backend.type).toBe("git");
  });

  it("local container spanning multiple module types resolves prompt targets", async () => {
    const home = await makeTempDir();
    cleanups.push(home);
    const dir = await makeTempDir();
    cleanups.push(dir);
    const service = new ContainerService(makePaths(home), new Git(testRun), new FakeGh() as unknown as Gh);

    await service.addContainer({ source: dir, name: "notes", create: true });
    for (const [path, type] of [["kb", "knowledge"], ["skills", "skills"], ["mem", "memory"]] as const) {
      await service.addModule({ container: "notes", path, type, name: path, create: true });
    }

    const targets = await service.resolveTargets("notes");
    expect(targets[0]!.modules.map((m) => m.type).sort()).toEqual(["knowledge", "memory", "skills"]);
  });
});
