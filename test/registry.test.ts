import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { makePaths, makeTempDir } from "./helpers.js";
import {
  loadRegistry,
  saveRegistry,
  findContainer,
  requireContainer,
  withContainerAdded,
  withContainerRemoved,
  withContainerUpdated,
  epermDestinationMatchesIntended,
} from "../src/registry/registry.js";
import { emptyRegistry, type ContainerEntry, containerEntrySchema } from "../src/registry/schema.js";
import { OkhError } from "../src/errors.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function entry(over: Partial<ContainerEntry> = {}): ContainerEntry {
  return {
    name: "my-hub",
    backend: { type: "local", config: {} },
    localPath: "/tmp/my-hub",
    sync: { mode: "auto", config: {} },
    addedAt: "2026-07-02T00:00:00.000Z",
    ...over,
  };
}

describe("registry store", () => {
  it("treats a missing file as an empty registry", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const reg = await loadRegistry(makePaths(home));
    expect(reg.containers).toEqual([]);
    expect(reg.version).toBe(2);
  });

  it("round-trips through save/load atomically", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const paths = makePaths(home);
    const reg = withContainerAdded(emptyRegistry(), entry());
    await saveRegistry(paths, reg);
    const back = await loadRegistry(paths);
    expect(back.containers).toHaveLength(1);
    expect(findContainer(back, "my-hub")?.backend.type).toBe("local");
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

  it("persists version 2 to disk", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const paths = makePaths(home);
    await saveRegistry(paths, emptyRegistry());
    const raw = JSON.parse(await readFile(paths.registryFile, "utf8"));
    expect(raw.version).toBe(2);
  });

  it("migrates a v1 git pr entry to v2 shared", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const paths = makePaths(home);
    await mkdir(dirname(paths.registryFile), { recursive: true });
    await writeFile(paths.registryFile, JSON.stringify({
      version: 1,
      containers: [{
        name: "team",
        backend: "git",
        origin: "https://github.com/example/team.git",
        localPath: "/tmp/team",
        sync: "pr",
        addedAt: "2026-07-02T00:00:00.000Z",
      }],
    }));

    const reg = await loadRegistry(paths, { resolveGitLogin: async () => "alice" });

    expect(reg.version).toBe(2);
    expect(reg.containers[0]).toMatchObject({
      backend: { type: "git", config: { origin: "https://github.com/example/team.git" } },
      sync: { mode: "shared", config: { branch: "user/alice/hub" } },
    });
    expect(JSON.parse(await readFile(paths.registryFile, "utf8")).version).toBe(2);
  });

  it("does not rewrite a v1 git pr registry when login resolution fails", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const paths = makePaths(home);
    const legacy = JSON.stringify({
      version: 1,
      containers: [{
        name: "team",
        backend: "git",
        origin: "https://github.com/example/team.git",
        localPath: "/tmp/team",
        sync: "pr",
        addedAt: "2026-07-02T00:00:00.000Z",
      }],
    });
    await mkdir(dirname(paths.registryFile), { recursive: true });
    await writeFile(paths.registryFile, legacy);

    await expect(loadRegistry(paths, {
      resolveGitLogin: async () => { throw new Error("not logged in"); },
    })).rejects.toThrow(/gh auth login|legacy.*pr/i);
    expect(await readFile(paths.registryFile, "utf8")).toBe(legacy);
  });

  it("migrates a non-git v1 pr entry to auto", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const paths = makePaths(home);
    await mkdir(dirname(paths.registryFile), { recursive: true });
    await writeFile(paths.registryFile, JSON.stringify({
      version: 1,
      containers: [{
        name: "notes",
        backend: "local",
        localPath: "/tmp/notes",
        sync: "pr",
        addedAt: "2026-07-02T00:00:00.000Z",
      }],
    }));

    const reg = await loadRegistry(paths);
    expect(reg.containers[0]?.sync).toEqual({ mode: "auto", config: {} });
  });

  it("migrates a v1 git auto entry preserving origin", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const paths = makePaths(home);
    await mkdir(dirname(paths.registryFile), { recursive: true });
    await writeFile(paths.registryFile, JSON.stringify({
      version: 1,
      containers: [{
        name: "hub",
        backend: "git",
        origin: "https://github.com/example/hub.git",
        localPath: "/tmp/hub",
        sync: "auto",
        addedAt: "2026-07-02T00:00:00.000Z",
      }],
    }));

    const reg = await loadRegistry(paths);
    expect(reg.containers[0]).toMatchObject({
      backend: { type: "git", config: { origin: "https://github.com/example/hub.git" } },
      sync: { mode: "auto", config: {} },
    });
  });

  it("fails migration for a v1 git entry without origin", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    const paths = makePaths(home);
    await mkdir(dirname(paths.registryFile), { recursive: true });
    await writeFile(paths.registryFile, JSON.stringify({
      version: 1,
      containers: [{
        name: "bad",
        backend: "git",
        localPath: "/tmp/bad",
        sync: "auto",
        addedAt: "2026-07-02T00:00:00.000Z",
      }],
    }));

    await expect(loadRegistry(paths)).rejects.toMatchObject({
      code: "INVALID_MANIFEST",
      message: expect.stringMatching(/origin|bad/i),
    });
  });
});

describe("container entry sync", () => {
  it("defaults sync to auto", () => {
    const e = containerEntrySchema.parse({
      name: "h", backend: { type: "local", config: {} }, localPath: "/x", addedAt: new Date().toISOString(),
    });
    expect(e.sync).toEqual({ mode: "auto", config: {} });
  });
  it("accepts shared mode", () => {
    const e = containerEntrySchema.parse({
      name: "h", backend: { type: "git", config: {} }, localPath: "/x", addedAt: new Date().toISOString(),
      sync: { mode: "shared", config: { branch: "user/bob/hub" } },
    });
    expect(e.sync.mode).toBe("shared");
    expect(e.sync.config).toEqual({ branch: "user/bob/hub" });
  });
  it("rejects an unknown sync mode", () => {
    expect(() => containerEntrySchema.parse({
      name: "h", backend: { type: "local", config: {} }, localPath: "/x", addedAt: new Date().toISOString(),
      sync: { mode: "nope" },
    })).toThrow();
  });
});

describe("EPERM concurrent save — epermDestinationMatchesIntended", () => {
  it("returns true when destination contains the identical serialised registry", () => {
    const reg = emptyRegistry();
    const raw = `${JSON.stringify(reg, null, 2)}\n`;
    expect(epermDestinationMatchesIntended(reg, raw)).toBe(true);
  });

  it("returns true with a non-empty registry serialised identically", () => {
    const reg = withContainerAdded(emptyRegistry(), entry());
    const raw = `${JSON.stringify(reg, null, 2)}\n`;
    expect(epermDestinationMatchesIntended(reg, raw)).toBe(true);
  });

  it("returns false when destination has fewer containers than intended", () => {
    const intended = withContainerAdded(emptyRegistry(), entry());
    const different = emptyRegistry();
    expect(epermDestinationMatchesIntended(intended, `${JSON.stringify(different, null, 2)}\n`)).toBe(false);
  });

  it("returns false when destination has a different container entry", () => {
    const intended = withContainerAdded(emptyRegistry(), entry());
    const different = withContainerAdded(emptyRegistry(), entry({ name: "other-hub" }));
    expect(epermDestinationMatchesIntended(intended, `${JSON.stringify(different, null, 2)}\n`)).toBe(false);
  });

  it("returns false for invalid JSON in the destination", () => {
    expect(epermDestinationMatchesIntended(emptyRegistry(), "not-json")).toBe(false);
  });

  it("returns false when destination schema validation fails (wrong version)", () => {
    expect(epermDestinationMatchesIntended(
      emptyRegistry(),
      '{"version":99,"containers":[]}',
    )).toBe(false);
  });

  it("returns false when the read itself failed (Error passed)", () => {
    const readError = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    expect(epermDestinationMatchesIntended(emptyRegistry(), readError)).toBe(false);
  });
});
