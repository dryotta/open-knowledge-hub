import { describe, it, expect, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { saveModuleManifest } from "../src/modules/manifest.js";
import { makePaths, makeTempDir, makeOrigin, testRun } from "./helpers.js";

class FakeGh {
  async createRepo(): Promise<string> { return "x"; }
  async createPr(): Promise<string> { return "x"; }
}
const cleanups: string[] = [];
async function setup() {
  const home = await makeTempDir(); cleanups.push(home);
  const service = new ContainerService(makePaths(home), new Git(testRun), new FakeGh() as unknown as Gh);
  return { service };
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Create a module folder with a per-module manifest inside a container root. */
async function seedModule(containerRoot: string, path: string, type: string, name: string, description = ""): Promise<void> {
  const moduleRoot = join(containerRoot, path);
  await mkdir(moduleRoot, { recursive: true });
  await saveModuleManifest(moduleRoot, { type, name, description, config: {} });
}

describe("status", () => {
  it("reports git status + modules for a git container", async () => {
    const origin = await makeOrigin();
    const { service } = await setup();
    await service.addContainer({ source: origin, name: "hub", create: true });
    const list = await service.list();
    const root = list[0]!.localPath;
    await seedModule(root, "kb", "knowledge", "KB", "team kb");
    const st = await service.status("hub");
    expect(st.backend).toBe("git");
    expect(st.manifestValid).toBe(true);
    expect(st.git?.branch).toBe("main");
    expect(st.modules).toEqual([{ path: "kb", type: "knowledge", name: "KB", description: "team kb", items: 0 }]);
  });

  it("omits git status for a local container", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "notes", create: true });
    const st = await service.status("notes");
    expect(st.git).toBeUndefined();
    expect(st.sync?.mode).toBe("auto");
  });
});

describe("validate", () => {
  it("flags a knowledge module without index.md", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await seedModule(dir, "kb", "knowledge", "KB");
    const res = await service.validate("hub");
    expect(res.ok).toBe(false);
    expect(res.issues.join("\n")).toMatch(/index\.md/i);
  });

  it("flags a skills module without index.md", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await seedModule(dir, "skills", "skills", "Skills");
    const res = await service.validate("hub");
    expect(res.ok).toBe(false);
    expect(res.issues.join("\n")).toMatch(/skills module "skills": missing index\.md/i);
  });

  it("flags an llmwiki module without index.md", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await seedModule(dir, "wiki", "llmwiki", "Wiki");
    const res = await service.validate("hub");
    expect(res.ok).toBe(false);
    expect(res.issues.join("\n")).toMatch(/llmwiki module "wiki": missing index\.md/i);
  });

  it("flags invalid nested skill leaves and duplicate names", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await service.addModule({ container: "hub", path: "skills", type: "skills", name: "Skills", create: true });
    await mkdir(join(dir, "skills", "engineering", "debug"), { recursive: true });
    await mkdir(join(dir, "skills", "data", "debug"), { recursive: true });
    await mkdir(join(dir, "skills", "ops", "broken"), { recursive: true });
    await writeFile(join(dir, "skills", "engineering", "debug", "SKILL.md"), "---\nname: debug\n---\n");
    await writeFile(join(dir, "skills", "data", "debug", "SKILL.md"), "---\nname: debug\n---\n");
    await writeFile(join(dir, "skills", "ops", "broken", "SKILL.md"), "# Missing name\n");

    const res = await service.validate("hub");

    expect(res.ok).toBe(false);
    expect(res.issues.join("\n")).toMatch(/duplicate skill name "debug"/);
    expect(res.issues.join("\n")).toMatch(/missing non-empty frontmatter name/);
  });

  it("keeps valid skills inspectable when a sibling leaf is malformed", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await service.addModule({ container: "hub", path: "skills", type: "skills", name: "Skills", create: true });
    await mkdir(join(dir, "skills", "good"), { recursive: true });
    await mkdir(join(dir, "skills", "broken"), { recursive: true });
    await writeFile(join(dir, "skills", "good", "SKILL.md"), "---\nname: good\n---\n\nWorks.\n");
    await writeFile(join(dir, "skills", "broken", "SKILL.md"), "# Missing name\n");

    const inspected = await service.inspect("hub", "skills");
    if (inspected.kind !== "module") throw new Error("expected module inspect result");

    expect(inspected.skills.map((skill) => skill.name)).toContain("good");
    expect(inspected.skillIssues?.join("\n")).toMatch(/broken\/SKILL\.md/);
    expect((await service.resolveSkill("hub", "skills", "good")).body).toContain("Works");
  });

  it("passes for a well-formed container", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await service.addModule({ container: "hub", path: "kb", type: "knowledge", name: "KB", create: true });
    // addModule scaffolds index.md; also need per-module manifest for discovery
    await saveModuleManifest(join(dir, "kb"), { type: "knowledge", name: "KB", description: "" });
    expect((await service.validate("hub")).ok).toBe(true);
  });
});

describe("inspect", () => {
  it("lists containers with no args", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    const res = await service.inspect();
    expect(res.kind).toBe("containers");
    if (res.kind === "containers") expect(res.containers[0]!.name).toBe("hub");
  });

  it("lists each container's modules in the top-level inspect", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await seedModule(dir, "kb", "knowledge", "KB", "team kb");
    const res = await service.inspect();
    expect(res.kind).toBe("containers");
    if (res.kind === "containers") {
      expect(res.containers[0]!.modules).toEqual([{ path: "kb", type: "knowledge", name: "KB" }]);
    }
  });

  it("returns container status with a container arg, and module items with both", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await seedModule(dir, "kb", "knowledge", "KB", "team kb");
    const c = await service.inspect("hub");
    expect(c.kind).toBe("container");
    const m = await service.inspect("hub", "kb");
    expect(m.kind).toBe("module");
    if (m.kind === "module") {
      expect(m.module.type).toBe("knowledge");
      expect(m.module.name).toBe("KB");
      expect(m.module.description).toBe("team kb");
    }
  });

  it("throws NOT_FOUND for an unknown module", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await expect(service.inspect("hub", "ghost")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("includes the module's overview (index.md scope contract)", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await service.addModule({ container: "hub", path: "kb", type: "knowledge", name: "KB", create: true });
    await writeFile(join(dir, "kb", "index.md"), "# KB\n\n## Goals\n\nKnow the auth system.\n", "utf8");
    const m = await service.inspect("hub", "kb");
    expect(m.kind).toBe("module");
    if (m.kind === "module") expect(m.overview).toContain("Know the auth system.");
  });

  it("includes a skills module's scope contract and nested skill paths", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    const { service } = await setup();
    await service.addContainer({ source: dir, name: "hub", create: true });
    await service.addModule({ container: "hub", path: "skills", type: "skills", name: "Skills", create: true });
    await writeFile(join(dir, "skills", "index.md"), "# Team skills\n\nGrouped by capability area.\n", "utf8");
    await mkdir(join(dir, "skills", "engineering", "testing", "debug"), { recursive: true });
    await writeFile(
      join(dir, "skills", "engineering", "testing", "debug", "SKILL.md"),
      "---\nname: debug\ndescription: Find root causes\n---\n\nDebug.\n",
    );

    const inspected = await service.inspect("hub", "skills");
    if (inspected.kind !== "module") throw new Error("expected module inspect result");

    expect(inspected.overview).toContain("Grouped by capability area.");
    expect(inspected.items).toContainEqual(expect.objectContaining({
      path: "engineering/testing/debug/SKILL.md",
    }));
    expect(inspected.skills).toContainEqual(expect.objectContaining({
      name: "debug",
      source: "module-root",
      path: "engineering/testing/debug/SKILL.md",
    }));
  });
});
