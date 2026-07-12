import { describe, it, expect } from "vitest";
import { formatSyncDescriptor } from "../src/util/syncFormat.js";

describe("formatSyncDescriptor", () => {
  it("returns '?' for undefined", () => {
    expect(formatSyncDescriptor(undefined)).toBe("?");
  });

  it("returns 'auto' for auto mode with empty config", () => {
    expect(formatSyncDescriptor({ mode: "auto", config: {} })).toBe("auto");
  });

  it("returns 'shared' for shared mode with empty config", () => {
    expect(formatSyncDescriptor({ mode: "shared", config: {} })).toBe("shared");
  });

  it("returns 'shared (branch=...)' for shared mode with a string branch", () => {
    expect(formatSyncDescriptor({ mode: "shared", config: { branch: "user/alice/hub" } })).toBe(
      "shared (branch=user/alice/hub)",
    );
  });

  it("does not render [object Object] for truthy non-string branch — returns 'shared'", () => {
    const result = formatSyncDescriptor({ mode: "shared", config: { branch: { ref: "main" } as unknown as string } });
    expect(result).toBe("shared");
    expect(result).not.toContain("[object Object]");
  });
});
