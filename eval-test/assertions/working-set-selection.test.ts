import { describe, expect, it } from "vitest";
import workingSetSelection from "../../eval/assertions/working-set-selection.js";

const config = {
  required: ["skills/debugging/SKILL\\.md", "tools/csv/README\\.md"],
  forbidden: ["kb/auth\\.md", "mem/"],
};
const evaluate = (finalMessage?: string) =>
  workingSetSelection("", { config, providerResponse: { metadata: { finalMessage } } });

describe("working-set-selection assertion", () => {
  it("allows rejected paths in a later gaps explanation", () => {
    const result = evaluate([
      "## Selected Working Set",
      "- skills/debugging/SKILL.md",
      "- tools/csv/README.md",
      "## Gaps Identified",
      "kb/auth.md and mem/ do not cover CSV parsing.",
    ].join("\n"));
    expect(result.pass).toBe(true);
  });

  it.each([
    "**Gaps:** kb/auth.md and mem/ do not cover CSV parsing.",
    "Missing Coverage: kb/auth.md and mem/ do not cover CSV parsing.",
    "## Limitations\nkb/auth.md and mem/ do not cover CSV parsing.",
  ])("recognizes alternate gap boundary: %s", (gap) => {
    const result = evaluate([
      "## Selected Working Set",
      "- skills/debugging/SKILL.md",
      "- tools/csv/README.md",
      gap,
    ].join("\n"));
    expect(result.pass).toBe(true);
  });

  it("rejects an irrelevant path selected before the gaps section", () => {
    const result = evaluate([
      "## Selected Working Set",
      "- skills/debugging/SKILL.md",
      "- tools/csv/README.md",
      "- mem/recent.md might help",
      "## Gaps",
      "No CSV knowledge.",
    ].join("\n"));
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/forbidden selected.*mem\//i);
  });

  it("allows a rejected path in an explicitly negative list item", () => {
    const result = evaluate([
      "## Selected Working Set",
      "- skills/debugging/SKILL.md",
      "- tools/csv/README.md",
      "- No relevant knowledge selected; kb/auth.md is unrelated.",
      "- No relevant memory selected from mem/.",
    ].join("\n"));
    expect(result.pass).toBe(true);
  });

  it("requires both task-relevant selected paths", () => {
    const result = evaluate("## Selected Working Set\n- skills/debugging/SKILL.md");
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/missing selected.*tools\/csv/i);
  });

  it("rejects a missing final message", () => {
    expect(evaluate().reason).toMatch(/missing or empty/i);
  });
});
