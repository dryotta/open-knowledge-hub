import { describe, it, expect } from "vitest";
import {
  slugSchema,
  packEntrySchema,
  subpathSchema,
  repoUrlSchema,
  resolveSubpath,
  DEFAULT_PACK_SUBPATH,
} from "../src/catalog/schema.js";

describe("slugSchema", () => {
  it.each(["a", "my-pack", "pack-1", "a1-b2-c3"])("accepts %s", (s) => {
    expect(slugSchema.safeParse(s).success).toBe(true);
  });

  it.each(["", "Pack", "my_pack", "-lead", "trail-", "a--b", "UPPER", "with space"])(
    "rejects %s",
    (s) => {
      expect(slugSchema.safeParse(s).success).toBe(false);
    },
  );
});

describe("subpathSchema", () => {
  it.each(["knowledge", "a/b/c", "knowledge/billing"])("accepts %s", (s) => {
    expect(subpathSchema.safeParse(s).success).toBe(true);
  });
  it.each(["..", "../x", "a/../../b", "/abs/path", "a/../..", ""])("rejects %s", (s) => {
    expect(subpathSchema.safeParse(s).success).toBe(false);
  });
});

describe("resolveSubpath", () => {
  it("defaults an omitted subpath to 'knowledge'", () => {
    expect(resolveSubpath(undefined)).toBe(DEFAULT_PACK_SUBPATH);
    expect(resolveSubpath(undefined)).toBe("knowledge");
  });
  it.each([".", "./", "/", "  .  ", ""])("treats %j as the repo root", (s) => {
    expect(resolveSubpath(s)).toBeUndefined();
  });
  it.each(["knowledge/billing", "docs", "a/b"])("passes through explicit %s", (s) => {
    expect(resolveSubpath(s)).toBe(s);
  });
});

describe("repoUrlSchema", () => {
  it.each([
    "https://github.com/o/r.git",
    "ssh://git@github.com/o/r.git",
    "git@github.com:o/r.git",
    "file:///tmp/x",
    "/tmp/local/bare.git",
  ])("accepts %s", (s) => {
    expect(repoUrlSchema.safeParse(s).success).toBe(true);
  });
  it.each(["ext::sh -c 'id'", "fd::17", "transport::payload"])("rejects remote-helper %s", (s) => {
    expect(repoUrlSchema.safeParse(s).success).toBe(false);
  });
});

describe("packEntrySchema", () => {
  it("accepts a minimal entry", () => {
    const r = packEntrySchema.safeParse({
      slug: "alpha",
      repoUrl: "https://x/y.git",
      state: "registered",
      addedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown keys", () => {
    const r = packEntrySchema.safeParse({
      slug: "alpha",
      repoUrl: "https://x/y.git",
      state: "registered",
      addedAt: "2026-01-01T00:00:00.000Z",
      bogus: true,
    });
    expect(r.success).toBe(false);
  });
});
