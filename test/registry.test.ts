import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { makePaths, makeTempDir } from "./helpers.js";
import {
  loadRegistry,
  saveRegistry,
  findContainer,
  requireContainer,
  withContainerAdded,
  withContainerRemoved,
  withContainerUpdated,
} from "../src/registry/registry.js";
import { emptyRegistry, type ContainerEntry } from "../src/registry/schema.js";
import { OkhError } from "../src/errors.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function entry(over: Partial<ContainerEntry> = {}): ContainerEntry {
  return {
    name: "my-hub",
    backend: "local",
    localPath: "/tmp/my-hub",
    addedAt: "2026-07-02T00:00:00.000Z",
    ...over,
  };
}

describe("registry store", () => {
  it("treats a missing file as an empty registry", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const reg = await loadRegistry(makePaths(home));
    expect(reg.containers).toEqual([]);
    expect(reg.version).toBe(1);
  });

  it("round-trips through save/load atomically", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const paths = makePaths(home);
    const reg = withContainerAdded(emptyRegistry(), entry());
    await saveRegistry(paths, reg);
    const back = await loadRegistry(paths);
    expect(back.containers).toHaveLength(1);
    expect(findContainer(back, "my-hub")?.backend).toBe("local");
    // pretty-printed JSON with trailing newline
    expect(await readFile(paths.registryFile, "utf8")).toMatch(/\n$/);
  });

  it("rejects a duplicate name on add", () => {
    const reg = withContainerAdded(emptyRegistry(), entry());
    expect(() => withContainerAdded(reg, entry())).toThrow(OkhError);
  });

  it("requireContainer throws NOT_FOUND for a missing name", () => {
    expect(() => requireContainer(emptyRegistry(), "nope")).toThrow(/NOT_FOUND|No container/);
  });

  it("updates and removes entries immutably", () => {
    let reg = withContainerAdded(emptyRegistry(), entry());
    reg = withContainerUpdated(reg, "my-hub", (e) => ({ ...e, localPath: "/new" }));
    expect(findContainer(reg, "my-hub")?.localPath).toBe("/new");
    reg = withContainerRemoved(reg, "my-hub");
    expect(findContainer(reg, "my-hub")).toBeUndefined();
  });

  it("git entries require an origin", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const bad = { version: 1, containers: [{ ...entry({ backend: "git" }) }] };
    // origin missing -> schema refinement fails on save
    await expect(saveRegistry(makePaths(home), bad as never)).rejects.toBeTruthy();
  });
});
