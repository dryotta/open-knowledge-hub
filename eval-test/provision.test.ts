import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { provision } from "../eval/provision.js";
import { makeTempDir, testRun } from "../test/helpers.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Build a minimal fixture container dir on disk and return its path. */
async function makeFixture(): Promise<string> {
  const dir = await makeTempDir("okh-fix-"); cleanups.push(dir);
  await mkdir(join(dir, ".okh"), { recursive: true });
  await writeFile(join(dir, ".okh", "okh.yaml"), "name: hub\nsync: auto\nmodules:\n  - path: kb\n    type: knowledge\n", "utf8");
  await mkdir(join(dir, "kb"), { recursive: true });
  await writeFile(join(dir, "kb", "index.md"), "# Knowledge\n", "utf8");
  return dir;
}

describe("provision", () => {
  it("materializes a local container + isolated homes + mcp-config", async () => {
    const fixtureDir = await makeFixture();
    const prov = await provision({ scenario: "s", backend: "local", container: "hub", fixtureDir, repoRoot: "C:/repo", runner: testRun });
    cleanups.push(prov.root);

    // registry registers the container as local, pointing at the copied fixture
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    expect(reg.containers[0].backend).toBe("local");
    expect(reg.containers[0].localPath).toBe(prov.containerPath);
    expect(await readFile(join(prov.containerPath, ".okh", "okh.yaml"), "utf8")).toContain("name: hub");

    // mcp-config points OKH at the isolated OKH_HOME and the built server
    const mcp = JSON.parse(await readFile(join(prov.copilotHome, "mcp-config.json"), "utf8"));
    const server = mcp.mcpServers["open-knowledge-hub"];
    expect(server.env.OKH_HOME).toBe(prov.okhHome);
    expect(server.args.join(" ")).toContain("dist");
    expect(prov.originPath).toBeUndefined();
  });

  it("materializes a git-auto container with a seeded bare origin", async () => {
    const fixtureDir = await makeFixture();
    const prov = await provision({ scenario: "s", backend: "git-auto", container: "hub", fixtureDir, repoRoot: "C:/repo", runner: testRun });
    cleanups.push(prov.root);

    expect(prov.originPath).toBeTruthy();
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    expect(reg.containers[0].backend).toBe("git");
    expect(reg.containers[0].origin).toBe(prov.originPath);

    // a fresh clone of the origin has the seeded content
    const verify = await makeTempDir("okh-verify-"); cleanups.push(verify);
    await testRun("git", ["clone", prov.originPath!, join(verify, "c")]);
    expect(await readFile(join(verify, "c", "kb", "index.md"), "utf8")).toContain("# Knowledge");
  });
});
