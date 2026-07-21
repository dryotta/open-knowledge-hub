import { describe, it, expect } from "vitest";
import { containerEntrySchema, REGISTRY_VERSION } from "../src/registry/schema.js";

const base = {
  name: "widgets",
  backend: { type: "git", config: { origin: "https://github.com/acme/widgets.git" } },
  localPath: "/tmp/widgets",
  sync: { mode: "auto", config: {} },
  addedAt: new Date().toISOString(),
};

describe("containerEntrySchema wiki flag", () => {
  it("parses an entry without a wiki key (backward compatible)", () => {
    const parsed = containerEntrySchema.parse(base);
    expect(parsed.wiki).toBeUndefined();
  });

  it("parses an entry with wiki.enabled", () => {
    const parsed = containerEntrySchema.parse({ ...base, wiki: { enabled: true } });
    expect(parsed.wiki).toEqual({ enabled: true });
  });

  it("rejects unknown keys inside wiki", () => {
    expect(() => containerEntrySchema.parse({ ...base, wiki: { enabled: true, extra: 1 } })).toThrow();
  });

  it("keeps REGISTRY_VERSION at 2", () => {
    expect(REGISTRY_VERSION).toBe(2);
  });
});
