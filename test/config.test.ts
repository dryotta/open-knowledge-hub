import { describe, it, expect } from "vitest";
import { resolvePaths, packCloneDir } from "../src/config.js";
import { join } from "node:path";

describe("resolvePaths", () => {
  it("defaults to ~/.open-knowledge-hub", () => {
    const p = resolvePaths({}, "/home/alice");
    expect(p.home).toBe("/home/alice/.open-knowledge-hub");
    expect(p.packsDir).toBe("/home/alice/.open-knowledge-hub/packs");
    expect(p.manifestFile).toBe("/home/alice/.open-knowledge-hub/catalog.json");
  });

  it("honours an absolute OKH_HOME", () => {
    const p = resolvePaths({ OKH_HOME: "/opt/okh" }, "/home/alice");
    expect(p.home).toBe("/opt/okh");
  });

  it("resolves a relative OKH_HOME against cwd", () => {
    const p = resolvePaths({ OKH_HOME: "rel/okh" }, "/home/alice");
    expect(p.home).toBe(join(process.cwd(), "rel/okh"));
  });

  it("computes the clone dir for a slug", () => {
    const p = resolvePaths({ OKH_HOME: "/opt/okh" });
    expect(packCloneDir(p, "my-pack")).toBe("/opt/okh/packs/my-pack");
  });
});
