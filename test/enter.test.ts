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
