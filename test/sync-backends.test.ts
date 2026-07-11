import { describe, it, expect } from "vitest";
import { BackendRegistry } from "../src/sync/backendRegistry.js";
import { PassiveBackend } from "../src/sync/passiveBackend.js";
import type { ContainerEntry } from "../src/registry/schema.js";
import { OkhError } from "../src/errors.js";

function makeEntry(override: Partial<ContainerEntry> = {}): ContainerEntry {
  return {
    name: "my-hub",
    backend: { type: "local", config: {} },
    localPath: "/data/my-hub",
    sync: { mode: "auto", config: {} },
    addedAt: "2026-07-02T00:00:00.000Z",
    ...override,
  };
}

describe("PassiveBackend", () => {
  it("has correct type and modes for local", () => {
    const b = new PassiveBackend("local");
    expect(b.type).toBe("local");
    expect(b.modes).toEqual(["auto"]);
  });

  it("has correct type and modes for onedrive", () => {
    const b = new PassiveBackend("onedrive");
    expect(b.type).toBe("onedrive");
    expect(b.modes).toEqual(["auto"]);
  });

  it("resolveBackendConfig accepts empty config", () => {
    const b = new PassiveBackend("local");
    expect(b.resolveBackendConfig({})).toEqual({});
  });

  it("resolveBackendConfig rejects unknown keys", () => {
    const b = new PassiveBackend("local");
    expect(() => b.resolveBackendConfig({ unknownKey: "x" })).toThrow(OkhError);
  });

  it("resolveSync returns auto selection for valid auto input", async () => {
    const b = new PassiveBackend("local");
    const result = await b.resolveSync({ mode: "auto", config: {} }, { containerName: "my-hub" });
    expect(result).toEqual({ mode: "auto", config: {} });
  });

  it("resolveSync rejects non-auto mode explicitly", async () => {
    const b = new PassiveBackend("local");
    await expect(
      b.resolveSync({ mode: "shared", config: {} }, { containerName: "my-hub" }),
    ).rejects.toThrow(OkhError);
  });

  it("resolveSync rejects unknown sync config keys", async () => {
    const b = new PassiveBackend("local");
    await expect(
      b.resolveSync({ mode: "auto", config: { extra: true } }, { containerName: "my-hub" }),
    ).rejects.toThrow(OkhError);
  });

  it("actions returns empty array", () => {
    const b = new PassiveBackend("local");
    expect(b.actions({ mode: "auto", config: {} })).toEqual([]);
  });

  it("sync returns validated outcome for valid request without action", async () => {
    const b = new PassiveBackend("local");
    const result = await b.sync({
      entry: makeEntry(),
      validation: { ok: true, issues: [] },
    });
    expect(result).toEqual({ mode: "auto", outcome: "validated" });
  });

  it("sync rejects any action", async () => {
    const b = new PassiveBackend("local");
    await expect(
      b.sync({
        entry: makeEntry(),
        validation: { ok: true, issues: [] },
        action: "push",
      }),
    ).rejects.toThrow(OkhError);
  });
});

describe("BackendRegistry", () => {
  it("looks up a registered backend by type", () => {
    const registry = new BackendRegistry([new PassiveBackend("local")]);
    expect(registry.require("local").type).toBe("local");
  });

  it("throws INVALID_ARGUMENT for unknown backend type listing supported types", () => {
    const registry = new BackendRegistry([new PassiveBackend("local")]);
    expect(() => registry.require("git")).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT", message: expect.stringContaining("local") }),
    );
  });

  it("rejects duplicate backend type registration", () => {
    expect(
      () => new BackendRegistry([new PassiveBackend("local"), new PassiveBackend("local")]),
    ).toThrow(OkhError);
  });

  it("resolveBackendConfig delegates to the adapter", () => {
    const registry = new BackendRegistry([new PassiveBackend("local")]);
    expect(registry.resolveBackendConfig("local", {})).toEqual({});
  });

  it("resolveSync resolves local/onedrive auto mode", async () => {
    const registry = new BackendRegistry([new PassiveBackend("local")]);
    const result = await registry.resolveSync("local", { mode: "auto", config: {} }, { containerName: "x" });
    expect(result).toEqual({ mode: "auto", config: {} });
  });

  it("resolveSync rejects unsupported mode listing supported modes (auto)", async () => {
    const registry = new BackendRegistry([new PassiveBackend("local")]);
    await expect(
      registry.resolveSync("local", { mode: "shared", config: {} }, { containerName: "x" }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT", message: expect.stringContaining("auto") }),
    );
  });

  it("actions(type, selection) returns mode actions", () => {
    const registry = new BackendRegistry([new PassiveBackend("local")]);
    expect(registry.actions("local", { mode: "auto", config: {} })).toEqual([]);
  });

  it("actions(entry) returns mode actions", () => {
    const registry = new BackendRegistry([new PassiveBackend("local")]);
    expect(registry.actions(makeEntry())).toEqual([]);
  });

  describe("validateEntry", () => {
    it("accepts a valid local entry", async () => {
      const registry = new BackendRegistry([new PassiveBackend("local")]);
      await expect(registry.validateEntry(makeEntry())).resolves.toBeUndefined();
    });

    it("accepts a valid onedrive entry", async () => {
      const registry = new BackendRegistry([new PassiveBackend("onedrive")]);
      await expect(
        registry.validateEntry(makeEntry({ backend: { type: "onedrive", config: {} } })),
      ).resolves.toBeUndefined();
    });

    it("rejects unknown backend config key", async () => {
      const registry = new BackendRegistry([new PassiveBackend("local")]);
      await expect(
        registry.validateEntry(makeEntry({ backend: { type: "local", config: { extra: "x" } } })),
      ).rejects.toThrow(OkhError);
    });

    it("rejects unknown sync config key", async () => {
      const registry = new BackendRegistry([new PassiveBackend("local")]);
      await expect(
        registry.validateEntry(makeEntry({ sync: { mode: "auto", config: { extra: "x" } } })),
      ).rejects.toThrow(OkhError);
    });

    it("rejects unsupported sync mode for local backend", async () => {
      const registry = new BackendRegistry([new PassiveBackend("local")]);
      const entry: ContainerEntry = { ...makeEntry(), sync: { mode: "shared", config: {} } };
      await expect(registry.validateEntry(entry)).rejects.toThrowError(
        expect.objectContaining({ code: "INVALID_ARGUMENT", message: expect.stringContaining("auto") }),
      );
    });
  });

  describe("validateEntries", () => {
    it("accepts all valid entries", async () => {
      const registry = new BackendRegistry([
        new PassiveBackend("local"),
        new PassiveBackend("onedrive"),
      ]);
      const entries: ContainerEntry[] = [
        makeEntry({ name: "hub-1", backend: { type: "local", config: {} } }),
        makeEntry({ name: "hub-2", backend: { type: "onedrive", config: {} } }),
      ];
      await expect(registry.validateEntries(entries)).resolves.toBeUndefined();
    });

    it("rejects on an invalid entry among valid ones", async () => {
      const registry = new BackendRegistry([new PassiveBackend("local")]);
      const entries: ContainerEntry[] = [
        makeEntry({ name: "good" }),
        makeEntry({ name: "bad", backend: { type: "local", config: { extra: true } } }),
      ];
      await expect(registry.validateEntries(entries)).rejects.toThrow(OkhError);
    });
  });
});
