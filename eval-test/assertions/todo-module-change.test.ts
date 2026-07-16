import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../../test/helpers.js";
import todoModuleChange from "../../eval/assertions/todo-module-change.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function pair(contents: string): Promise<{ fixture: string; container: string }> {
  const fixture = await makeTempDir("todo-change-fixture-");
  const container = await makeTempDir("todo-change-container-");
  cleanups.push(fixture, container);
  await mkdir(join(fixture, "mem"), { recursive: true });
  await mkdir(join(container, "mem"), { recursive: true });
  await writeFile(join(fixture, "mem", "existing.md"), contents, "utf8");
  await writeFile(join(container, "mem", "existing.md"), contents, "utf8");
  return { fixture, container };
}

const context = (
  fixtureDir: string,
  containerPath: string,
  operation: "create" | "update",
  text: string,
) => ({
  config: { module: "mem", operation, text },
  providerResponse: { metadata: { fixtureDir, containerPath } },
});

describe("todo-module-change assertion", () => {
  it("accepts one appended todo while preserving prior memory content", async () => {
    const prior = "## Existing\n\n- [ ] Review launch notes #todo #work\n";
    const { fixture, container } = await pair(prior);
    await writeFile(
      join(container, "mem", "2026-07-14.md"),
      "### 2026-07-14T12:00:00Z — Buy printer ink\n\n- [ ] Buy printer ink #todo #shopping ⏫ 📅 2026-07-15 ➕ 2026-07-14\n",
      "utf8",
    );
    const result = await todoModuleChange("", context(fixture, container, "create", "buy printer ink"));
    expect(result.pass).toBe(true);
  });

  it("rejects duplicate todo creation", async () => {
    const { fixture, container } = await pair("## Existing\n");
    await writeFile(
      join(container, "mem", "2026-07-14.md"),
      "- [ ] Buy printer ink #todo #shopping\n- [ ] Buy printer ink #todo #shopping\n",
      "utf8",
    );
    const result = await todoModuleChange("", context(fixture, container, "create", "buy printer ink"));
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/exactly one matching todo/i);
  });

  it("accepts completing exactly one target line", async () => {
    const prior = [
      "## Todos",
      "",
      "- [ ] Buy milk #todo #shopping ➕ 2026-07-10",
      "- [ ] Review launch notes #todo #work",
      "",
    ].join("\n");
    const { fixture, container } = await pair(prior);
    await writeFile(
      join(container, "mem", "existing.md"),
      prior.replace("- [ ] Buy milk", "- [x] Buy milk").replace(" ➕ 2026-07-10", " ✅ 2026-07-14 ➕ 2026-07-10"),
      "utf8",
    );
    const result = await todoModuleChange("", context(fixture, container, "update", "Buy milk"));
    expect(result.pass).toBe(true);
  });

  it("rejects collateral changes to unrelated content", async () => {
    const prior = [
      "## Todos",
      "",
      "- [ ] Buy milk #todo #shopping ➕ 2026-07-10",
      "- [ ] Review launch notes #todo #work",
      "",
    ].join("\n");
    const { fixture, container } = await pair(prior);
    await writeFile(
      join(container, "mem", "existing.md"),
      prior
        .replace("- [ ] Buy milk", "- [x] Buy milk")
        .replace(" ➕ 2026-07-10", " ✅ 2026-07-14 ➕ 2026-07-10")
        .replace("Review launch notes", "Review modified notes"),
      "utf8",
    );
    const result = await todoModuleChange("", context(fixture, container, "update", "Buy milk"));
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/changed 2 lines/i);
  });
});
