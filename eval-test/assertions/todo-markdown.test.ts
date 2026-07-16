import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../../test/helpers.js";
import todoMarkdown from "../../eval/assertions/todo-markdown.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(files: Record<string, string>, module = "mem"): Promise<string> {
  const root = await makeTempDir("todo-markdown-");
  cleanups.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(root, module, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }
  return root;
}

function ctx(containerPath: string | undefined, config: Record<string, unknown> | undefined) {
  return {
    ...(config === undefined ? {} : { config }),
    providerResponse: { metadata: { ...(containerPath === undefined ? {} : { containerPath }) } },
  };
}

describe("todo-markdown assertion", () => {
  it("passes an exact configured match and normalizes expected labels", async () => {
    const root = await makeRoot({
      "tasks.md": "- [ ] Review launch notes #todo #Work #private ⏫ 📅 2026-07-20 ➕ 2026-07-10\n",
    });

    const result = await todoMarkdown("", ctx(root, {
      text: "LAUNCH NOTES",
      status: "open",
      labels: [" #work ", "##PRIVATE"],
      due: "2026-07-20",
      priority: " HIGH ",
    }));

    expect(result).toEqual({
      pass: true,
      score: 1,
      reason: "matched todo at tasks.md:1",
    });
  });

  it("names a required label when it is missing", async () => {
    const root = await makeRoot({ "tasks.md": "- [ ] Buy milk #todo #shopping\n" });

    const result = await todoMarkdown("", ctx(root, { text: "buy milk", labels: ["errands"] }));

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("missing label #errands");
  });

  it("reports an open/completed status mismatch", async () => {
    const root = await makeRoot({ "tasks.md": "- [ ] Buy milk #shopping\n" });

    const result = await todoMarkdown("", ctx(root, { text: "buy milk", status: "completed" }));

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("status expected completed, found open");
  });

  it("reports due and priority mismatches", async () => {
    const root = await makeRoot({ "tasks.md": "- [ ] Buy milk #shopping 🔽 📅 2026-07-12\n" });

    const result = await todoMarkdown("", ctx(root, {
      text: "buy milk",
      due: "2026-07-15",
      priority: "high",
    }));

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("due expected 2026-07-15, found 2026-07-12");
    expect(result.reason).toContain("priority expected high, found low");
  });

  it("distinguishes no matching task text from field mismatches", async () => {
    const root = await makeRoot({ "tasks.md": "- [ ] Buy milk #shopping\n" });

    const result = await todoMarkdown("", ctx(root, { text: "printer ink" }));

    expect(result).toEqual({
      pass: false,
      score: 0,
      reason: 'no todo text match for "printer ink" in module "mem"',
    });
  });

  it("rejects duplicate matching todos", async () => {
    const root = await makeRoot({
      "tasks.md": "- [ ] Buy printer ink #shopping\n- [ ] Buy printer ink #shopping\n",
    });
    const result = await todoMarkdown("", ctx(root, {
      text: "buy printer ink",
      status: "open",
      labels: ["shopping"],
    }));
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/exactly one matching todo/i);
  });

  it("does not crash on prose or malformed checkbox metadata", async () => {
    const root = await makeRoot({
      "mixed.md": [
        "# Notes",
        "ordinary prose 📅 2026-07-15",
        "- [] broken checkbox",
        "- [ ] Printer ink #shopping 📅 not-a-date",
        "- [?] Custom task #shopping ⏫",
        "",
      ].join("\n"),
    });

    await expect(todoMarkdown("", ctx(root, {
      text: "printer ink",
      due: "2026-07-15",
    }))).resolves.toMatchObject({
      pass: false,
      score: 0,
      reason: expect.stringContaining("due expected 2026-07-15, found none"),
    });
  });

  it("scans Markdown recursively and ignores non-Markdown files", async () => {
    const root = await makeRoot({
      "nested/deep/tasks.MD": "- [x] Recursive task #Archive ✅ 2026-07-10\n",
      "ignored.txt": "- [ ] Text-only task #shopping\n",
    });

    expect((await todoMarkdown("", ctx(root, {
      text: "recursive task",
      status: "completed",
      labels: ["archive"],
    }))).pass).toBe(true);
    expect((await todoMarkdown("", ctx(root, { text: "text-only task" }))).reason)
      .toBe('no todo text match for "text-only task" in module "mem"');
  });

  it("orders aggregate mismatch details by file and line", async () => {
    const root = await makeRoot({
      "z/tasks.md": "- [ ] Buy milk #shopping\n",
      "a.md": "\n- [x] Buy milk #shopping\n",
    });

    const result = await todoMarkdown("", ctx(root, {
      text: "buy milk",
      status: "open",
      labels: ["urgent"],
      due: "2026-07-20",
      priority: "high",
    }));

    expect(result.reason).toBe(
      "matching todo text found, but fields mismatched: " +
      "a.md:2 [missing label #urgent; status expected open, found completed; " +
      "due expected 2026-07-20, found none; priority expected high, found normal] | " +
      "z/tasks.md:1 [missing label #urgent; due expected 2026-07-20, found none; " +
      "priority expected high, found normal]",
    );
  });

  it("fails cleanly for missing config, metadata, container, or module", async () => {
    const root = await makeRoot({ "tasks.md": "- [ ] Buy milk\n" });

    await expect(todoMarkdown("", ctx(root, undefined))).resolves.toMatchObject({
      pass: false,
      reason: "missing assertion config",
    });
    await expect(todoMarkdown("", { config: { text: "buy milk" } })).resolves.toMatchObject({
      pass: false,
      reason: "missing containerPath in metadata",
    });
    await expect(todoMarkdown("", ctx(join(root, "missing-container"), { text: "buy milk" }))).resolves.toMatchObject({
      pass: false,
      reason: "container path not found",
    });
    await expect(todoMarkdown("", ctx(root, { text: " " }))).resolves.toMatchObject({
      pass: false,
      reason: "config.text must be a non-empty string",
    });
    await expect(todoMarkdown("", ctx(root, { text: "buy milk", module: "" }))).resolves.toMatchObject({
      pass: false,
      reason: "config.module must be a non-empty relative path",
    });
    await expect(todoMarkdown("", ctx(root, { text: "buy milk", module: "missing" }))).resolves.toMatchObject({
      pass: false,
      reason: 'module path not found: "missing"',
    });
  });

  it("fails cleanly for malformed configured field types", async () => {
    const root = await makeRoot({ "tasks.md": "- [ ] Buy milk\n" });

    await expect(todoMarkdown("", ctx(root, { text: "buy milk", module: 42 }))).resolves.toMatchObject({
      pass: false,
      reason: "config.module must be a non-empty relative path",
    });
    await expect(todoMarkdown("", ctx(root, { text: "buy milk", due: 20260715 }))).resolves.toMatchObject({
      pass: false,
      reason: "config.due must be a non-empty string",
    });
    await expect(todoMarkdown("", ctx(root, { text: "buy milk", priority: ["high"] }))).resolves.toMatchObject({
      pass: false,
      reason: expect.stringContaining("config.priority must be one of"),
    });
  });
});
