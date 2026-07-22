import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import { readModuleAgentsFile, MAX_AGENTS_FILE_BYTES } from "../src/modules/agentsFile.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await makeTempDir("okh-enter-");
  cleanups.push(d);
  return d;
}

describe("readModuleAgentsFile", () => {
  it("returns present with the content when AGENTS.md is a regular file", async () => {
    const root = await tmp();
    await writeFile(join(root, "AGENTS.md"), "# Guide\nline\n", "utf8");
    const result = await readModuleAgentsFile(root);
    expect(result).toEqual({ status: "present", content: "# Guide\nline\n" });
  });

  it("returns absent when there is no AGENTS.md", async () => {
    const root = await tmp();
    expect(await readModuleAgentsFile(root)).toEqual({ status: "absent" });
  });

  it("rejects a symlinked AGENTS.md as unsafe", async () => {
    const root = await tmp();
    const outside = await tmp();
    await writeFile(join(outside, "secret.md"), "secret", "utf8");
    await symlink(join(outside, "secret.md"), join(root, "AGENTS.md"));
    const result = await readModuleAgentsFile(root);
    expect(result.status).toBe("unsafe");
  });

  it("rejects an AGENTS.md that exceeds the byte cap", async () => {
    const root = await tmp();
    await writeFile(join(root, "AGENTS.md"), "x".repeat(MAX_AGENTS_FILE_BYTES + 1), "utf8");
    const result = await readModuleAgentsFile(root);
    expect(result.status).toBe("unsafe");
  });
});

import { buildEnter } from "../src/prompts/index.js";
import type { ResolvedContainer, ResolvedModule } from "../src/container/service.js";
import type { Skill } from "../src/modules/skills.js";
import type { AgentsFileResult } from "../src/modules/agentsFile.js";

function fakeTarget(): ResolvedContainer {
  return {
    name: "hub",
    backend: "local",
    sync: { mode: "auto", config: {} },
    syncActions: [],
    root: "/abs/hub",
    modules: [],
  };
}
function fakeModule(type = "folder"): ResolvedModule {
  return { type, path: "work", description: "", absPath: "/abs/hub/work" };
}
const skill = (name: string, description = ""): Skill => ({ name, description, body: "b", source: "vendored" });

describe("buildEnter", () => {
  it("declares the working folder and appends the write policy", async () => {
    const text = await buildEnter(fakeTarget(), fakeModule(), [], { status: "absent" });
    expect(text).toContain("/abs/hub/work");
    expect(text).toMatch(/working directory/i);
    expect(text).toMatch(/Write policy/i);
    expect(text).toMatch(/sync/i);
  });

  it("inlines AGENTS.md content when present", async () => {
    const agents: AgentsFileResult = { status: "present", content: "# Folder Guide\nDo the thing." };
    const text = await buildEnter(fakeTarget(), fakeModule(), [], agents);
    expect(text).toContain("# Folder Guide");
    expect(text).toContain("Do the thing.");
  });

  it("notes an absent AGENTS.md and hints initialize for folder modules", async () => {
    const text = await buildEnter(fakeTarget(), fakeModule("folder"), [], { status: "absent" });
    expect(text).toMatch(/No .*AGENTS\.md/i);
    expect(text).toMatch(/initialize/i);
  });

  it("omits the initialize hint for non-folder modules", async () => {
    const text = await buildEnter(fakeTarget(), fakeModule("knowledge"), [], { status: "absent" });
    expect(text).toMatch(/No .*AGENTS\.md/i);
    expect(text).not.toMatch(/skill: "initialize"/);
  });

  it("reports an unsafe AGENTS.md with its reason and does not inline it", async () => {
    const agents: AgentsFileResult = { status: "unsafe", reason: "symbolic links are not allowed" };
    const text = await buildEnter(fakeTarget(), fakeModule(), [], agents);
    expect(text).toMatch(/not loaded|not read|could not/i);
    expect(text).toContain("symbolic links are not allowed");
  });

  it("lists the module's skills, and states none when empty", async () => {
    const withSkills = await buildEnter(fakeTarget(), fakeModule(), [skill("initialize", "author AGENTS.md")], { status: "absent" });
    expect(withSkills).toContain("initialize");
    expect(withSkills).toContain("author AGENTS.md");

    const noSkills = await buildEnter(fakeTarget(), fakeModule(), [], { status: "absent" });
    expect(noSkills).toMatch(/no skills/i);
  });
});
