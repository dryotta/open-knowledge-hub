import { describe, it, expect } from "vitest";
import { pathSlug } from "../src/wiki/slug.js";

describe("pathSlug", () => {
  it("encodes nested paths", () => {
    expect(pathSlug("sources/eed.md")).toBe("sources-eed");
    expect(pathSlug("cross-cutting/id-pivots.md")).toBe("cross-cutting-id-pivots");
  });
  it("handles root-level files", () => {
    expect(pathSlug("glossary.md")).toBe("glossary");
  });
  it("preserves an existing extension on non-md assets", () => {
    expect(pathSlug("assets/retry.png")).toBe("assets-retry.png");
  });
  it("preserves case", () => {
    expect(pathSlug("Areas/Meeting-Join.md")).toBe("Areas-Meeting-Join");
  });
});
