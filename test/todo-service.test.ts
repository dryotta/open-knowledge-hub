import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContainerService } from "../src/container/service.js";
import { OkhError } from "../src/errors.js";
import { TodoService } from "../src/todos/service.js";
import { makePaths, makeTempDir, writeModule } from "./helpers.js";

const cleanups: string[] = [];

function decodeRef(ref: string) {
  return JSON.parse(Buffer.from(ref, "base64url").toString("utf8")) as {
    v: number;
    container: string;
    module: string;
    path: string;
    line: number;
    fingerprint: string;
    id?: string;
  };
}

async function setupTodoServiceFixture() {
  const home = await makeTempDir("okh-todos-");
  cleanups.push(home);

  const paths = makePaths(home);
  const containers = new ContainerService(paths);
  const containerRoot = join(home, "alpha-container");
  await mkdir(containerRoot, { recursive: true });
  await containers.addContainer({ source: containerRoot, name: "alpha", create: true });

  await writeModule(containerRoot, "memory", { type: "memory", name: "Memory Display" });
  await writeModule(containerRoot, "knowledge", { type: "knowledge", name: "Knowledge Display" });

  const notes = [
    "# Notes",
    "- [ ] Buy milk #todo #shopping 🔺 📅 2026-07-09 ➕ 2026-07-01 🆔 milk-1",
    "- [x] File taxes #todo #finance 📅 2026-07-08 ✅ 2026-07-08 ➕ 2026-07-02",
    "- [ ] Broken dates 📅 someday 📅 2026-07-11",
    "",
  ].join("\n");
  await writeFile(join(containerRoot, "memory", "notes.md"), notes, "utf8");
  await mkdir(join(containerRoot, "memory", "nested"), { recursive: true });
  await writeFile(join(containerRoot, "memory", "nested", "tasks.md"), "- [ ] Plan trip #todo #travel ➕ 2026-07-05\n", "utf8");
  await writeFile(join(containerRoot, "memory", "ignore.txt"), "- [ ] Ignore me\n", "utf8");
  await writeFile(join(containerRoot, "knowledge", "notes.md"), "- [ ] Hidden knowledge task #todo\n", "utf8");

  const service = new TodoService(containers, () => new Date("2026-07-10T08:00:00.000Z"));
  return { service, containerRoot };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("TodoService.list", () => {
  it("recursively scans only memory markdown and returns source-aware opaque refs", async () => {
    const { service } = await setupTodoServiceFixture();

    const result = await service.list();

    expect(result.tasks.map((task) => task.text)).toEqual([
      "Buy milk",
      "File taxes",
      "Broken dates",
      "Plan trip",
    ]);
    expect(result.counts).toEqual({ total: 4, open: 3, completed: 1, custom: 0 });

    const buyMilk = result.tasks[0]!;
    const locator = decodeRef(buyMilk.ref);
    expect(buyMilk.source).toEqual({
      container: "alpha",
      module: "memory",
      path: "notes.md",
      line: 2,
    });
    expect(locator).toEqual({
      v: 1,
      container: "alpha",
      module: "memory",
      path: "notes.md",
      line: 2,
      fingerprint: createHash("sha256").update("- [ ] Buy milk #todo #shopping 🔺 📅 2026-07-09 ➕ 2026-07-01 🆔 milk-1", "utf8").digest("hex"),
      id: "milk-1",
    });
    expect(buyMilk.ref).toBe(Buffer.from(JSON.stringify(locator), "utf8").toString("base64url"));
    expect(result.tasks.some((task) => task.text === "Hidden knowledge task")).toBe(false);
    expect(result.tasks.some((task) => task.text === "Ignore me")).toBe(false);

    const planTrip = result.tasks.find((task) => task.text === "Plan trip");
    expect(planTrip?.source.path).toBe("nested/tasks.md");
    expect(decodeRef(planTrip!.ref).id).toBeUndefined();
  });

  it("reports parser warnings with source coordinates and computes counts from filtered tasks", async () => {
    const { service } = await setupTodoServiceFixture();

    const completed = await service.list({ status: "completed" });

    expect(completed.tasks.map((task) => task.text)).toEqual(["File taxes"]);
    expect(completed.counts).toEqual({ total: 1, open: 0, completed: 1, custom: 0 });

    const all = await service.list();
    expect(all.warnings).toEqual([
      {
        source: { container: "alpha", module: "memory", path: "notes.md", line: 4 },
        message: 'Invalid due date "someday".',
      },
      {
        source: { container: "alpha", module: "memory", path: "notes.md", line: 4 },
        message: "Duplicate due date metadata found; using the last valid value.",
      },
    ]);
  });

  it("rejects invalid dates and inverted ranges before resolving targets", async () => {
    const resolveTargets = vi.fn(async () => []);
    const service = new TodoService({ resolveTargets } as unknown as ContainerService);

    await expect(service.list({ dueAfter: "2026-02-30" })).rejects.toMatchObject<Partial<OkhError>>({
      code: "INVALID_ARGUMENT",
    });
    await expect(service.list({ dueBefore: "2026-07-32" })).rejects.toMatchObject<Partial<OkhError>>({
      code: "INVALID_ARGUMENT",
    });
    await expect(service.list({ dueAfter: "2026-07-11", dueBefore: "2026-07-10" })).rejects.toMatchObject<Partial<OkhError>>({
      code: "INVALID_ARGUMENT",
    });

    expect(resolveTargets).not.toHaveBeenCalled();
  });
});
