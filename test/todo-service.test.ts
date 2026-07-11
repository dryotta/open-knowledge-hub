import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContainerService } from "../src/container/service.js";
import { OkhError } from "../src/errors.js";
import { TodoService } from "../src/todos/service.js";
import { makePaths, makeTempDir, writeModule } from "./helpers.js";

const cleanups: string[] = [];

type MutationCapableTodoService = TodoService & {
  mutate(input: unknown): Promise<unknown>;
};

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

function encodeRef(locator: unknown): string {
  return Buffer.from(JSON.stringify(locator), "utf8").toString("base64url");
}

async function readSource(relativePath: string): Promise<string> {
  return readFile(join(process.cwd(), relativePath), "utf8");
}

async function mutateTodo(service: TodoService, input: unknown) {
  return (service as MutationCapableTodoService).mutate(input);
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
  it("does not retain the legacy patch compatibility API in todo sources", async () => {
    const [typesSource, serviceSource] = await Promise.all([
      readSource("src/todos/types.ts"),
      readSource("src/todos/service.ts"),
    ]);

    expect(typesSource).not.toContain("TodoUpdateInput");
    expect(typesSource).not.toContain("TodoUpdateResult");
    expect(typesSource).not.toContain('operation: "patch"');
    expect(serviceSource).not.toContain("TodoUpdateInput");
    expect(serviceSource).not.toContain("TodoUpdateResult");
    expect(serviceSource).not.toMatch(/\basync update\(/);
  });

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

describe("TodoService.mutate", () => {
  it("previews a create without writing and applies the same create when confirmed", async () => {
    const { service, containerRoot } = await setupTodoServiceFixture();
    const target = join(containerRoot, "memory", "2026-07-10.md");

    const input = {
      operation: "create" as const,
      container: "alpha",
      module: "memory",
      text: "Preview me",
      labels: ["work"],
    };

    const preview = await mutateTodo(service, input) as {
      operation: string;
      applied: boolean;
      needsConfirmation?: boolean;
      preview: {
        line: string;
        source: { container: string; module: string; path: string; line: number };
        todo: {
          text: string;
          labels: string[];
          priority: string;
          created?: string;
          source: { container: string; module: string; path: string; line: number };
        };
      };
    };

    expect(preview).toMatchObject({
      operation: "create",
      applied: false,
      needsConfirmation: true,
      preview: {
        line: "- [ ] Preview me #todo #work ➕ 2026-07-10",
        source: {
          container: "alpha",
          module: "memory",
          path: "2026-07-10.md",
          line: 3,
        },
        todo: {
          text: "Preview me",
          labels: ["work"],
          priority: "normal",
          created: "2026-07-10",
          source: {
            container: "alpha",
            module: "memory",
            path: "2026-07-10.md",
            line: 3,
          },
        },
      },
    });
    await expect(readFile(target, "utf8")).rejects.toHaveProperty("code", "ENOENT");

    const applied = await mutateTodo(service, { ...input, apply: true }) as {
      operation: string;
      applied: boolean;
      todo: {
        text: string;
        labels: string[];
        priority: string;
        created?: string;
        source: { container: string; module: string; path: string; line: number };
      };
      dirtyContainer: string;
    };

    expect(applied).toMatchObject({
      operation: "create",
      applied: true,
      dirtyContainer: "alpha",
      todo: {
        text: "Preview me",
        labels: ["work"],
        priority: "normal",
        created: "2026-07-10",
        source: {
          container: "alpha",
          module: "memory",
          path: "2026-07-10.md",
          line: 3,
        },
      },
    });
    expect(await readFile(target, "utf8")).toBe(
      [
        "### 2026-07-10T08:00:00.000Z — Todo",
        "",
        "- [ ] Preview me #todo #work ➕ 2026-07-10",
        "",
      ].join("\n"),
    );
  });

  it("creates a dated memory entry with trimmed text, default general label, and canonical metadata", async () => {
    const { service, containerRoot } = await setupTodoServiceFixture();

    const result = await mutateTodo(service, {
      operation: "create",
      container: "alpha",
      module: "memory",
      text: "  Buy milk  ",
      entrySummary: "  Daily Tasks  ",
      observation: "  Needs to happen today.  ",
      due: "2026-07-11",
      priority: "high",
      apply: true,
    }) as {
      operation: string;
      applied: boolean;
      dirtyContainer: string;
      todo: {
        ref: string;
        text: string;
        labels: string[];
        priority: string;
        due?: string;
        created?: string;
        id?: string;
        source: { container: string; module: string; path: string; line: number };
      };
    };

    expect(result.operation).toBe("create");
    expect(result.applied).toBe(true);
    expect(result.dirtyContainer).toBe("alpha");
    expect(result.todo).toMatchObject({
      text: "Buy milk",
      labels: ["general"],
      priority: "high",
      due: "2026-07-11",
      created: "2026-07-10",
      id: undefined,
      source: {
        container: "alpha",
        module: "memory",
        path: "2026-07-10.md",
        line: 5,
      },
    });
    expect(decodeRef(result.todo.ref)).toEqual({
      v: 1,
      container: "alpha",
      module: "memory",
      path: "2026-07-10.md",
      line: 5,
      fingerprint: createHash("sha256")
        .update("- [ ] Buy milk #todo #general ⏫ 📅 2026-07-11 ➕ 2026-07-10", "utf8")
        .digest("hex"),
    });
    expect(await readFile(join(containerRoot, "memory", "2026-07-10.md"), "utf8")).toBe(
      [
        "### 2026-07-10T08:00:00.000Z — Daily Tasks",
        "",
        "Needs to happen today.",
        "",
        "- [ ] Buy milk #todo #general ⏫ 📅 2026-07-11 ➕ 2026-07-10",
        "",
      ].join("\n"),
    );
  });

  it("appends to existing LF dated files while preserving blank-line separation and missing final newline", async () => {
    const { service, containerRoot } = await setupTodoServiceFixture();
    const target = join(containerRoot, "memory", "2026-07-10.md");
    await writeFile(
      target,
      [
        "### 2026-07-09T08:00:00.000Z — Yesterday",
        "",
        "- [ ] Existing #todo #work ➕ 2026-07-09",
      ].join("\n"),
      "utf8",
    );

    await mutateTodo(service, {
      operation: "create",
      container: "alpha",
      module: "memory",
      text: "New task",
      apply: true,
    });

    expect(await readFile(target, "utf8")).toBe(
      [
        "### 2026-07-09T08:00:00.000Z — Yesterday",
        "",
        "- [ ] Existing #todo #work ➕ 2026-07-09",
        "",
        "### 2026-07-10T08:00:00.000Z — Todo",
        "",
        "- [ ] New task #todo #general ➕ 2026-07-10",
      ].join("\n"),
    );
  });

  it("appends to existing CRLF dated files while preserving CRLF and final newline", async () => {
    const { service, containerRoot } = await setupTodoServiceFixture();
    const target = join(containerRoot, "memory", "2026-07-10.md");
    await writeFile(
      target,
      [
        "### 2026-07-09T08:00:00.000Z — Yesterday",
        "",
        "- [ ] Existing #todo #work ➕ 2026-07-09",
        "",
      ].join("\r\n"),
      "utf8",
    );

    await mutateTodo(service, {
      operation: "create",
      container: "alpha",
      module: "memory",
      text: "New task",
      labels: ["home"],
      apply: true,
    });

    expect(await readFile(target, "utf8")).toBe(
      [
        "### 2026-07-09T08:00:00.000Z — Yesterday",
        "",
        "- [ ] Existing #todo #work ➕ 2026-07-09",
        "",
        "### 2026-07-10T08:00:00.000Z — Todo",
        "",
        "- [ ] New task #todo #home ➕ 2026-07-10",
        "",
      ].join("\r\n"),
    );
  });

  it("previews an update without writing and reapplies it against current state", async () => {
    const { service, containerRoot } = await setupTodoServiceFixture();
    const target = join(containerRoot, "memory", "moved.md");
    await writeFile(
      target,
      [
        "# Tasks",
        "- [ ] Move me #todo #ops ➕ 2026-07-09",
        "- [ ] Neighbor #todo #ops ➕ 2026-07-09",
        "",
      ].join("\n"),
      "utf8",
    );
    const beforePreview = await readFile(target, "utf8");

    const listed = await service.list();
    const original = listed.tasks.find((task) => task.source.path === "moved.md" && task.text === "Move me");
    expect(original).toBeDefined();

    const preview = await mutateTodo(service, {
      operation: "update",
      ref: original!.ref,
      completed: true,
    }) as {
      operation: string;
      applied: boolean;
      needsConfirmation?: boolean;
      preview: {
        line: string;
        source: { path: string; line: number };
        todo: { completed?: string; status: string; source: { path: string; line: number } };
      };
    };

    expect(preview).toMatchObject({
      operation: "update",
      applied: false,
      needsConfirmation: true,
      preview: {
        line: "- [x] Move me #todo #ops ➕ 2026-07-09 ✅ 2026-07-10",
        source: {
          path: "moved.md",
          line: 2,
        },
        todo: {
          status: "completed",
          completed: "2026-07-10",
          source: {
            path: "moved.md",
            line: 2,
          },
        },
      },
    });
    expect(await readFile(target, "utf8")).toBe(beforePreview);

    await writeFile(
      target,
      [
        "# Tasks",
        "- [ ] Neighbor #todo #ops ➕ 2026-07-09",
        "",
        "- [ ] Move me #todo #ops ➕ 2026-07-09",
        "",
      ].join("\n"),
      "utf8",
    );

    const updated = await mutateTodo(service, {
      operation: "update",
      ref: original!.ref,
      completed: true,
      apply: true,
    }) as {
      operation: string;
      applied: boolean;
      todo: { source: { path: string; line: number }; completed?: string; status: string };
    };

    expect(updated.operation).toBe("update");
    expect(updated.applied).toBe(true);
    expect(updated.todo).toMatchObject({
      status: "completed",
      completed: "2026-07-10",
      source: {
        path: "moved.md",
        line: 4,
      },
    });
    await expect(mutateTodo(service, {
      operation: "update",
      ref: original!.ref,
      completed: false,
    })).rejects.toMatchObject<Partial<OkhError>>({
      code: "CONFLICT",
    });
  });

  it("uses a unique existing id even after the task moves and its text changes", async () => {
    const { service, containerRoot } = await setupTodoServiceFixture();
    const target = join(containerRoot, "memory", "notes.md");
    const listed = await service.list();
    const original = listed.tasks.find((task) => task.id === "milk-1");
    expect(original).toBeDefined();

    await writeFile(
      target,
      [
        "# Notes",
        "- [x] File taxes #todo #finance 📅 2026-07-08 ✅ 2026-07-08 ➕ 2026-07-02",
        "",
        "- [ ] Buy oat milk instead #todo #shopping 🔺 📅 2026-07-09 ➕ 2026-07-01 🆔 milk-1",
        "- [ ] Broken dates 📅 someday 📅 2026-07-11",
        "",
      ].join("\n"),
      "utf8",
    );

    const updated = await mutateTodo(service, {
      operation: "update",
      ref: original!.ref,
      labels: ["errands"],
      apply: true,
    }) as {
      todo: { text: string; labels: string[]; source: { path: string; line: number }; id?: string };
    };

    expect(updated.todo).toMatchObject({
      text: "Buy oat milk instead",
      labels: ["errands"],
      id: "milk-1",
      source: {
        path: "notes.md",
        line: 4,
      },
    });
  });

  it("rejects duplicate ids and duplicate fingerprints with CONFLICT", async () => {
    const { service, containerRoot } = await setupTodoServiceFixture();
    const duplicateIdsPath = join(containerRoot, "memory", "duplicate-ids.md");
    await writeFile(
      duplicateIdsPath,
      [
        "- [ ] One #todo 🆔 dup-1",
        "- [ ] Two #todo 🆔 dup-1",
        "",
      ].join("\n"),
      "utf8",
    );
    const duplicateFingerprintsPath = join(containerRoot, "memory", "duplicate-fingerprints.md");
    await writeFile(
      duplicateFingerprintsPath,
      [
        "# First",
        "- [ ] Same task #todo #work ➕ 2026-07-10",
        "- [ ] Same task #todo #work ➕ 2026-07-10",
        "",
      ].join("\n"),
      "utf8",
    );

    const listed = await service.list();
    const duplicateIdTask = listed.tasks.find((task) => task.source.path === "duplicate-ids.md" && task.text === "One");
    const fingerprintTask = listed.tasks.find((task) => task.source.path === "duplicate-fingerprints.md" && task.source.line === 2);
    expect(duplicateIdTask).toBeDefined();
    expect(fingerprintTask).toBeDefined();

    await expect(mutateTodo(service, {
      operation: "update",
      ref: duplicateIdTask!.ref,
      completed: true,
    })).rejects.toMatchObject<Partial<OkhError>>({
      code: "CONFLICT",
    });

    await writeFile(
      duplicateFingerprintsPath,
      [
        "# First",
        "- [ ] Moved elsewhere",
        "- [ ] Same task #todo #work ➕ 2026-07-10",
        "- [ ] Same task #todo #work ➕ 2026-07-10",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(mutateTodo(service, {
      operation: "update",
      ref: fingerprintTask!.ref,
      completed: true,
    })).rejects.toMatchObject<Partial<OkhError>>({
      code: "CONFLICT",
    });
  });

  it("updates by exact original line fingerprint when the target line still matches", async () => {
    const { service, containerRoot } = await setupTodoServiceFixture();
    const target = join(containerRoot, "memory", "exact-line.md");
    await writeFile(target, "- [ ] Exact line #todo #home ➕ 2026-07-09\n", "utf8");

    const listed = await service.list();
    const task = listed.tasks.find((todo) => todo.source.path === "exact-line.md");
    expect(task).toBeDefined();

    const result = await mutateTodo(service, {
      operation: "update",
      ref: task!.ref,
      due: "2026-07-20",
      apply: true,
    }) as {
      todo: { due?: string; source: { path: string; line: number } };
    };

    expect(result.todo).toMatchObject({
      due: "2026-07-20",
      source: { path: "exact-line.md", line: 1 },
    });
    expect(await readFile(target, "utf8")).toBe("- [ ] Exact line #todo #home 📅 2026-07-20 ➕ 2026-07-09\n");
  });

  it("rejects custom statuses with INVALID_ARGUMENT and leaves the file byte-identical", async () => {
    const { service, containerRoot } = await setupTodoServiceFixture();
    const target = join(containerRoot, "memory", "custom.md");
    await writeFile(
      target,
      [
        "- [/] Locked task #todo #ops",
        "- [ ] Open task #todo #ops",
        "",
      ].join("\n"),
      "utf8",
    );
    const before = await readFile(target);
    const listed = await service.list();
    const custom = listed.tasks.find((task) => task.source.path === "custom.md" && task.status === "custom");
    expect(custom).toBeDefined();

    await expect(mutateTodo(service, {
      operation: "update",
      ref: custom!.ref,
      completed: true,
    })).rejects.toMatchObject<Partial<OkhError>>({
      code: "INVALID_ARGUMENT",
    });
    expect(await readFile(target)).toEqual(before);
  });

  it("preserves CRLF and final-newline state on successful update", async () => {
    const { service, containerRoot } = await setupTodoServiceFixture();
    const target = join(containerRoot, "memory", "patch-crlf.md");
    await writeFile(
      target,
      [
        "- [ ] First task #todo #work",
        "- [ ] Second task #todo",
      ].join("\r\n"),
      "utf8",
    );

    const listed = await service.list();
    const first = listed.tasks.find((task) => task.source.path === "patch-crlf.md" && task.text === "First task");
    expect(first).toBeDefined();

    await mutateTodo(service, {
      operation: "update",
      ref: first!.ref,
      completed: true,
      apply: true,
    });

    expect(await readFile(target, "utf8")).toBe(
      [
        "- [x] First task #todo #work ✅ 2026-07-10",
        "- [ ] Second task #todo",
      ].join("\r\n"),
    );
  });

  it("rejects traversal, absolute, malformed, and non-markdown refs without touching outside files", async () => {
    const { service, containerRoot } = await setupTodoServiceFixture();
    const outside = join(containerRoot, "outside.md");
    await writeFile(outside, "outside\n", "utf8");
    const beforeOutside = await readFile(outside, "utf8");

    const invalidRefs = [
      encodeRef({ v: 1, container: "alpha", module: "memory", path: "../outside.md", line: 1, fingerprint: "abc" }),
      encodeRef({ v: 1, container: "alpha", module: "memory", path: "C:\\outside.md", line: 1, fingerprint: "abc" }),
      encodeRef({ v: 1, container: "alpha", module: "memory", path: "\\\\server\\share\\outside.md", line: 1, fingerprint: "abc" }),
      encodeRef({ v: 2, container: "alpha", module: "memory", path: "notes.md", line: 1, fingerprint: "abc" }),
      encodeRef({ v: 1, container: "", module: "memory", path: "notes.md", line: 1, fingerprint: "abc" }),
      encodeRef({ v: 1, container: "alpha", module: "", path: "notes.md", line: 1, fingerprint: "abc" }),
      encodeRef({ v: 1, container: "alpha", module: "memory", path: "", line: 1, fingerprint: "abc" }),
      encodeRef({ v: 1, container: "alpha", module: "memory", path: "notes.txt", line: 1, fingerprint: "abc" }),
      encodeRef({ v: 1, container: "alpha", module: "memory", path: "notes.md", line: 0, fingerprint: "abc" }),
      encodeRef({ v: 1, container: "alpha", module: "memory", path: "notes.md", line: 1.5, fingerprint: "abc" }),
      encodeRef({ v: 1, container: "alpha", module: "memory", path: "notes.md", line: 1, fingerprint: "" }),
      encodeRef({ v: 1, container: "alpha", module: "memory", path: "notes.md", line: 1, fingerprint: "abc", id: "" }),
      "not-base64url",
    ];

    for (const ref of invalidRefs) {
      await expect(mutateTodo(service, {
        operation: "update",
        ref,
        completed: true,
      })).rejects.toMatchObject<Partial<OkhError>>({
        code: "INVALID_ARGUMENT",
      });
    }

    expect(await readFile(outside, "utf8")).toBe(beforeOutside);
  });

  it("rejects missing or non-memory modules", async () => {
    const { service } = await setupTodoServiceFixture();

    await expect(mutateTodo(service, {
      operation: "create",
      container: "alpha",
      module: "missing",
      text: "Nope",
    })).rejects.toMatchObject<Partial<OkhError>>({
      code: "NOT_FOUND",
    });

    await expect(mutateTodo(service, {
      operation: "create",
      container: "alpha",
      module: "knowledge",
      text: "Nope",
    })).rejects.toMatchObject<Partial<OkhError>>({
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects invalid create and update inputs with INVALID_ARGUMENT and no writes", async () => {
    const { service, containerRoot } = await setupTodoServiceFixture();
    const notesPath = join(containerRoot, "memory", "notes.md");
    const dateFile = join(containerRoot, "memory", "2026-07-10.md");
    const notesBefore = await readFile(notesPath, "utf8");
    const listed = await service.list();
    const buyMilk = listed.tasks.find((task) => task.id === "milk-1");
    expect(buyMilk).toBeDefined();

    const invalidCases = [
      {
        operation: "create",
        container: "alpha",
        module: "memory",
        text: "   ",
      },
      {
        operation: "create",
        container: "alpha",
        module: "memory",
        text: "Task",
        labels: ["bad label"],
      },
      {
        operation: "create",
        container: "alpha",
        module: "memory",
        text: "Task",
        due: "2026-02-30",
      },
      {
        operation: "create",
        container: "alpha",
        module: "memory",
        text: "Task",
        priority: "urgent",
      },
      {
        operation: "update",
        ref: buyMilk!.ref,
      },
      {
        operation: "update",
        ref: buyMilk!.ref,
        labels: ["bad label"],
      },
      {
        operation: "update",
        ref: buyMilk!.ref,
        due: "2026-02-30",
      },
      {
        operation: "update",
        ref: buyMilk!.ref,
        priority: "urgent",
      },
    ];

    for (const input of invalidCases) {
      await expect(mutateTodo(service, input)).rejects.toMatchObject<Partial<OkhError>>({
        code: "INVALID_ARGUMENT",
      });
    }

    expect(await readFile(notesPath, "utf8")).toBe(notesBefore);
    await expect(readFile(dateFile, "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });
});
