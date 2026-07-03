import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir, makeOrigin, pushToOrigin } from "../test/helpers.js";
import toolsCalled from "../eval/assertions/tools-called.js";
import transcript from "../eval/assertions/transcript.js";
import okfValid from "../eval/assertions/okf-valid.js";
import memoryAppend from "../eval/assertions/memory-append.js";
import gitCommitted from "../eval/assertions/git-committed.js";

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
});

describe("memory-append", () => {
  it("passes when memory file count grew beyond baseline", async () => {
    const c = await makeTempDir("mem-"); cleanups.push(c);
    await mkdir(join(c, "mem"), { recursive: true });
    await writeFile(join(c, "mem", "2026-01-01.md"), "old\n", "utf8");
    await writeFile(join(c, "mem", "2026-07-02.md"), "new\n", "utf8");
    expect((await memoryAppend("", ctx({ containerPath: c }, { module: "mem", baselineFileCount: 1 }))).pass).toBe(true);
    expect((await memoryAppend("", ctx({ containerPath: c }, { module: "mem", baselineFileCount: 2 }))).pass).toBe(false);
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
