import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir, makeOrigin, pushToOrigin } from "../test/helpers.js";
import toolsCalled from "../eval/assertions/tools-called.js";
import transcript from "../eval/assertions/transcript.js";
import okfValid from "../eval/assertions/okf-valid.js";
import memoryAppend from "../eval/assertions/memory-append.js";
import gitCommitted from "../eval/assertions/git-committed.js";
import moduleUnchanged from "../eval/assertions/module-unchanged.js";
import containerRegistered from "../eval/assertions/container-registered.js";
import manifestInitialized from "../eval/assertions/manifest-initialized.js";
import wakePhraseSet from "../eval/assertions/wake-phrase-set.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const ctx = (metadata: Record<string, unknown>, config: Record<string, unknown> = {}) =>
  ({ providerResponse: { metadata }, config });

describe("tools-called", () => {
  it("passes when expected tools are present, fails when missing", () => {
    expect(toolsCalled("", ctx({ toolCalls: ["ask", "sync"] }, { expect: ["ask"] })).pass).toBe(true);
    expect(toolsCalled("", ctx({ toolCalls: ["ask"] }, { expect: ["learn"] })).pass).toBe(false);
  });
});

describe("transcript", () => {
  it("checks mustContain / mustNotContain", () => {
    expect(transcript("see kb/auth.md", ctx({}, { mustContain: ["kb/auth.md"] })).pass).toBe(true);
    expect(transcript("boom error", ctx({}, { mustNotContain: ["error"] })).pass).toBe(false);
  });
});

describe("okf-valid", () => {
  it("passes for valid OKF concepts, fails when a concept lacks a type", async () => {
    const c = await makeTempDir("okf-"); cleanups.push(c);
    await mkdir(join(c, "kb"), { recursive: true });
    await writeFile(join(c, "kb", "index.md"), "# Knowledge\n", "utf8");
    await writeFile(join(c, "kb", "auth.md"), "---\ntype: Concept\ntitle: Auth\n---\n# Auth\n# Citations\n[1] src\n", "utf8");
    expect((await okfValid("", ctx({ containerPath: c }, { module: "kb", requireCitations: true }))).pass).toBe(true);

    await writeFile(join(c, "kb", "bad.md"), "no frontmatter here\n", "utf8");
    expect((await okfValid("", ctx({ containerPath: c }, { module: "kb" }))).pass).toBe(false);
  });

  it("with requireChanged, fails when the module equals the fixture and passes when a concept changed", async () => {
    const fx = await makeTempDir("okf-fx-"); cleanups.push(fx);
    const c = await makeTempDir("okf-c-"); cleanups.push(c);
    await mkdir(join(fx, "kb"), { recursive: true });
    await mkdir(join(c, "kb"), { recursive: true });
    await writeFile(join(fx, "kb", "index.md"), "# Knowledge\n", "utf8");
    await writeFile(join(fx, "kb", "auth.md"), "---\ntype: Concept\n---\nbody\n", "utf8");
    await writeFile(join(c, "kb", "index.md"), "# Knowledge\n", "utf8");
    await writeFile(join(c, "kb", "auth.md"), "---\ntype: Concept\n---\nbody\n", "utf8");
    const meta = { containerPath: c, fixtureDir: fx };
    expect((await okfValid("", ctx(meta, { module: "kb", requireChanged: true }))).pass).toBe(false);
    // extend the existing concept (as a real learn run may) -> changed -> passes
    await writeFile(join(c, "kb", "auth.md"), "---\ntype: Concept\n---\nbody\n\n# Signing\nRS256\n", "utf8");
    expect((await okfValid("", ctx(meta, { module: "kb", requireChanged: true }))).pass).toBe(true);
  });
});

describe("memory-append", () => {
  async function pair(): Promise<{ fx: string; c: string }> {
    const fx = await makeTempDir("mem-fx-"); cleanups.push(fx);
    const c = await makeTempDir("mem-"); cleanups.push(c);
    await mkdir(join(fx, "mem"), { recursive: true });
    await mkdir(join(c, "mem"), { recursive: true });
    await writeFile(join(fx, "mem", "2026-01-01.md"), "old\n", "utf8");
    await writeFile(join(c, "mem", "2026-01-01.md"), "old\n", "utf8"); // container starts as a copy
    return { fx, c };
  }

  it("passes when a new entry is added and prior entries are unchanged (append-only)", async () => {
    const { fx, c } = await pair();
    await writeFile(join(c, "mem", "2026-07-02.md"), "new\n", "utf8");
    expect((await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", baselineFileCount: 1 }))).pass).toBe(true);
  });

  it("fails when a prior entry was rewritten (append-only violated)", async () => {
    const { fx, c } = await pair();
    await writeFile(join(c, "mem", "2026-01-01.md"), "REWRITTEN\n", "utf8"); // history changed
    await writeFile(join(c, "mem", "2026-07-02.md"), "new\n", "utf8");
    expect((await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", baselineFileCount: 1 }))).pass).toBe(false);
  });

  it("fails when no new entry was added", async () => {
    const { fx, c } = await pair();
    expect((await memoryAppend("", ctx({ containerPath: c, fixtureDir: fx }, { module: "mem", baselineFileCount: 1 }))).pass).toBe(false);
  });
});

describe("module-unchanged", () => {
  it("passes when the module equals the fixture, fails when a file was added", async () => {
    const fx = await makeTempDir("mu-fx-"); cleanups.push(fx);
    const c = await makeTempDir("mu-"); cleanups.push(c);
    await mkdir(join(fx, "kb"), { recursive: true });
    await mkdir(join(c, "kb"), { recursive: true });
    await writeFile(join(fx, "kb", "index.md"), "# k\n", "utf8");
    await writeFile(join(c, "kb", "index.md"), "# k\n", "utf8");
    expect((await moduleUnchanged("", ctx({ containerPath: c, fixtureDir: fx }, { module: "kb" }))).pass).toBe(true);
    await writeFile(join(c, "kb", "sky.md"), "the sky is blue\n", "utf8"); // unwanted write
    expect((await moduleUnchanged("", ctx({ containerPath: c, fixtureDir: fx }, { module: "kb" }))).pass).toBe(false);
  });
});

describe("git-committed", () => {
  it("passes when the origin has commits beyond the seed", async () => {
    const origin = await makeOrigin({ "kb/index.md": "# k\n" }); // 1 commit
    expect((await gitCommitted("", ctx({ originPath: origin }, { minCommits: 2 }))).pass).toBe(false);
    await pushToOrigin(origin, "kb/auth.md", "x"); // 2nd commit
    expect((await gitCommitted("", ctx({ originPath: origin }, { minCommits: 2 }))).pass).toBe(true);
  });
  it("fails cleanly for a non-git container", async () => {
    expect((await gitCommitted("", ctx({}, {}))).pass).toBe(false);
  });
});

async function okhHomeWith(name: string): Promise<string> {
  const home = await makeTempDir(); cleanups.push(home);
  const containers = join(home, "containers", name);
  await mkdir(join(containers, "kb", ".okh"), { recursive: true });
  await writeFile(join(containers, "kb", ".okh", "module.yaml"), `type: knowledge\nname: kb\ndescription: Test\n`, "utf8");
  await writeFile(join(home, "registry.json"), JSON.stringify({
    version: 1,
    containers: [{ name, backend: "local", localPath: containers, sync: "auto", addedAt: new Date().toISOString() }],
  }), "utf8");
  return home;
}

describe("onboarding assertions", () => {
  it("container-registered passes when the container exists with a valid manifest", async () => {
    const okhHome = await okhHomeWith("my-notes");
    const r = await containerRegistered("", { providerResponse: { metadata: { okhHome } }, config: { name: "my-notes", backend: "local" } });
    expect(r.pass).toBe(true);
  });

  it("container-registered fails when nothing is registered", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    await writeFile(join(home, "registry.json"), JSON.stringify({ version: 1, containers: [] }), "utf8");
    const r = await containerRegistered("", { providerResponse: { metadata: { okhHome: home } }, config: { name: "my-notes" } });
    expect(r.pass).toBe(false);
  });

  it("manifest-initialized passes for a registered container", async () => {
    const okhHome = await okhHomeWith("my-notes");
    const r = await manifestInitialized("", { providerResponse: { metadata: { okhHome } }, config: { name: "my-notes" } });
    expect(r.pass).toBe(true);
  });

  it("manifest-initialized fails when a registered container has no modules", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const containers = join(home, "containers", "my-notes");
    await mkdir(containers, { recursive: true });
    await writeFile(join(home, "registry.json"), JSON.stringify({
      version: 1,
      containers: [{ name: "my-notes", backend: "local", localPath: containers, sync: "auto", addedAt: new Date().toISOString() }],
    }), "utf8");
    const r = await manifestInitialized("", { providerResponse: { metadata: { okhHome: home } }, config: { name: "my-notes" } });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/no modules discovered/);
  });

  it("wake-phrase-set passes when a non-default phrase is persisted", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    await writeFile(join(home, "preferences.json"), JSON.stringify({ wakePhrase: "brain" }), "utf8");
    const r = await wakePhraseSet("", { providerResponse: { metadata: { okhHome: home } }, config: {} });
    expect(r.pass).toBe(true);
  });

  it("wake-phrase-set fails when the default phrase is unchanged", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    await writeFile(join(home, "preferences.json"), JSON.stringify({ wakePhrase: "hub" }), "utf8");
    const r = await wakePhraseSet("", { providerResponse: { metadata: { okhHome: home } }, config: { default: "hub" } });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("unchanged");
  });

  it("wake-phrase-set reports malformed preferences separately from a missing file", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    await writeFile(join(home, "preferences.json"), "{", "utf8");
    const r = await wakePhraseSet("", { providerResponse: { metadata: { okhHome: home } }, config: {} });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/invalid preferences\.json/);
  });
});
