import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolvePaths, containerCloneDir } from "../src/config.js";

describe("resolvePaths", () => {
  it("defaults to ~/.open-knowledge-hub", () => {
    const p = resolvePaths({}, "/home/me");
    expect(p.home).toBe(join("/home/me", ".open-knowledge-hub"));
    expect(p.containersDir).toBe(join("/home/me", ".open-knowledge-hub", "containers"));
    expect(p.registryFile).toBe(join("/home/me", ".open-knowledge-hub", "registry.json"));
  });

  it("honours an absolute OKH_HOME", () => {
    const p = resolvePaths({ OKH_HOME: "/data/okh" }, "/home/me");
    expect(p.home).toBe("/data/okh");
    expect(p.registryFile).toBe(join("/data/okh", "registry.json"));
  });

  it("containerCloneDir joins under containersDir", () => {
    const p = resolvePaths({ OKH_HOME: "/data/okh" }, "/home/me");
    expect(containerCloneDir(p, "my-hub")).toBe(join("/data/okh", "containers", "my-hub"));
  });
});
