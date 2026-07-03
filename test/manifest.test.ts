import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "./helpers.js";
import {
  loadContainerManifest,
  saveContainerManifest,
  scaffoldManifest,
  manifestPath,
  type ContainerManifest,
} from "../src/container/manifest.js";
import { OkhError } from "../src/errors.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("container manifest", () => {
  it("scaffolds an empty auto-sync manifest", () => {
    const m = scaffoldManifest("my-hub");
    expect(m).toEqual({ name: "my-hub", sync: "auto", modules: [] });
  });

  it("round-trips through save/load as YAML at .okh/okh.yaml", async () => {
    const root = await makeTempDir(); cleanups.push(root);
    const m: ContainerManifest = {
      name: "my-hub",
      sync: "pr",
      modules: [
        { path: "kb", type: "knowledge" },
        { path: "skills", type: "skills" },
      ],
    };
    await saveContainerManifest(root, m);
    expect(manifestPath(root)).toBe(join(root, ".okh", "okh.yaml"));
    expect(await readFile(manifestPath(root), "utf8")).toContain("type: knowledge");
    const back = await loadContainerManifest(root);
    expect(back).toEqual(m);
  });

  it("leaves no manifest temp files when replacing an existing manifest", async () => {
    const root = await makeTempDir(); cleanups.push(root);
    await saveContainerManifest(root, { name: "before", sync: "auto", modules: [] });

    const replacement: ContainerManifest = {
      name: "after",
      sync: "pr",
      modules: [{ path: "skills", type: "skills" }],
    };
    await saveContainerManifest(root, replacement);

    expect(await readdir(join(root, ".okh"))).toEqual(["okh.yaml"]);
    const raw = await readFile(manifestPath(root), "utf8");
    expect(raw).toContain("name: after");
    expect(raw).not.toContain("name: before");
    expect(await loadContainerManifest(root)).toEqual(replacement);
  });

  it("defaults sync to auto and modules to [] when omitted", async () => {
    const root = await makeTempDir(); cleanups.push(root);
    await saveContainerManifest(root, { name: "x", sync: "auto", modules: [] });
    // hand-write a minimal manifest without sync/modules
    const { writeManifest } = await import("./helpers.js");
    await writeManifest(root, "name: x\n");
    const back = await loadContainerManifest(root);
    expect(back.sync).toBe("auto");
    expect(back.modules).toEqual([]);
  });

  it("throws INVALID_MANIFEST when the file is missing", async () => {
    const root = await makeTempDir(); cleanups.push(root);
    await expect(loadContainerManifest(root)).rejects.toBeInstanceOf(OkhError);
  });

  it("rejects an unknown module type", async () => {
    const root = await makeTempDir(); cleanups.push(root);
    const { writeManifest } = await import("./helpers.js");
    await writeManifest(root, "name: x\nmodules:\n  - path: k\n    type: nope\n");
    await expect(loadContainerManifest(root)).rejects.toBeInstanceOf(OkhError);
  });

  it("rejects a module path containing ..", async () => {
    const root = await makeTempDir(); cleanups.push(root);
    const { writeManifest } = await import("./helpers.js");
    await writeManifest(root, "name: x\nmodules:\n  - path: ../escape\n    type: knowledge\n");
    await expect(loadContainerManifest(root)).rejects.toBeInstanceOf(OkhError);
  });
});
