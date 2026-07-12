/**
 * Integration tests for the EPERM-on-rename path in saveRegistry.
 *
 * We mock `node:fs/promises` so that `rename` can be made to throw EPERM on
 * demand while all other fs primitives (mkdir, writeFile, readFile, unlink)
 * remain real.  Each test controls the mock via `renameMode`.
 */
import { vi, describe, it, expect, afterEach } from "vitest";
import { rm, stat } from "node:fs/promises";
import { makeTempDir, makePaths } from "./helpers.js";
import { emptyRegistry } from "../src/registry/schema.js";
import { withContainerAdded } from "../src/registry/registry.js";

// ---------------------------------------------------------------------------
// Rename mock — controlled per test via `renameMode`
// ---------------------------------------------------------------------------
type RenameMode = "real" | "eperm";
let renameMode: RenameMode = "real";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    rename: async (from: string, to: string): Promise<void> => {
      if (renameMode === "eperm") {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      }
      return real.rename(from, to);
    },
  };
});

// Import AFTER vi.mock so the module sees the mocked rename
const { saveRegistry } = await import("../src/registry/registry.js");
const { writeFile, mkdir, readFile } = await import("node:fs/promises");
const { dirname, join } = await import("node:path");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function epermError(): NodeJS.ErrnoException {
  return Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
}

const cleanups: string[] = [];
afterEach(async () => {
  renameMode = "real";
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function entry() {
  return {
    name: "my-hub",
    backend: { type: "local" as const, config: {} },
    localPath: "/tmp/my-hub",
    sync: { mode: "auto" as const, config: {} },
    addedAt: "2026-07-02T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("saveRegistry — EPERM on rename", () => {
  it("succeeds and cleans up the temp file when the destination already has identical data", async () => {
    const home = await makeTempDir("okh-eperm-ok-");
    cleanups.push(home);
    const paths = makePaths(home);
    const reg = withContainerAdded(emptyRegistry(), entry());

    // Pre-populate the destination with the same data that saveRegistry would write
    await mkdir(dirname(paths.registryFile), { recursive: true });
    await writeFile(paths.registryFile, `${JSON.stringify(reg, null, 2)}\n`, "utf8");

    // Make rename throw EPERM (simulating a concurrent write that already committed)
    renameMode = "eperm";
    await expect(saveRegistry(paths, reg)).resolves.toBeUndefined();

    // The destination is still valid
    const saved = JSON.parse(await readFile(paths.registryFile, "utf8"));
    expect(saved.version).toBe(2);
    expect(saved.containers).toHaveLength(1);

    // No stray temp files should remain under the home dir
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(home);
    const temps = files.filter((f) => f.includes(".tmp-"));
    expect(temps).toHaveLength(0);
  });

  it("rejects with the original EPERM when the destination has different data", async () => {
    const home = await makeTempDir("okh-eperm-diff-");
    cleanups.push(home);
    const paths = makePaths(home);
    const intended = withContainerAdded(emptyRegistry(), entry());
    const different = emptyRegistry(); // fewer containers

    // Pre-populate with *different* data
    await mkdir(dirname(paths.registryFile), { recursive: true });
    await writeFile(paths.registryFile, `${JSON.stringify(different, null, 2)}\n`, "utf8");

    renameMode = "eperm";
    const err = await saveRegistry(paths, intended).catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("EPERM");

    // Temp file cleaned up even on failure
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(home);
    const temps = files.filter((f) => f.includes(".tmp-"));
    expect(temps).toHaveLength(0);
  });

  it("rejects with the original EPERM when the destination is missing", async () => {
    const home = await makeTempDir("okh-eperm-missing-");
    cleanups.push(home);
    const paths = makePaths(home);
    const reg = emptyRegistry();

    await mkdir(dirname(paths.registryFile), { recursive: true });
    // Do NOT write the destination — simulate absent file
    renameMode = "eperm";
    const err = await saveRegistry(paths, reg).catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("EPERM");
  });

  it("rejects with the original EPERM when the destination has invalid JSON", async () => {
    const home = await makeTempDir("okh-eperm-invalid-");
    cleanups.push(home);
    const paths = makePaths(home);
    const reg = emptyRegistry();

    await mkdir(dirname(paths.registryFile), { recursive: true });
    await writeFile(paths.registryFile, "not-valid-json", "utf8");

    renameMode = "eperm";
    const err = await saveRegistry(paths, reg).catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("EPERM");
  });
});
