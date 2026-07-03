import { describe, it, expect } from "vitest";
import { parseFrontmatter, stringField } from "../src/util/frontmatter.js";

describe("parseFrontmatter", () => {
  it("splits frontmatter data from the body", () => {
    const { data, body } = parseFrontmatter("---\ntitle: Hi\ntype: Note\n---\n# Body\n");
    expect(data.title).toBe("Hi");
    expect(stringField(data, "type")).toBe("Note");
    expect(body).toBe("# Body\n");
  });

  it("returns empty data and the full text when there is no frontmatter", () => {
    const { data, body } = parseFrontmatter("# Just markdown\n");
    expect(data).toEqual({});
    expect(body).toBe("# Just markdown\n");
  });

  it("tolerates invalid YAML by returning empty data", () => {
    const { data } = parseFrontmatter("---\n:\n::\n---\nbody");
    expect(data).toEqual({});
  });

  it("handles CRLF line endings", () => {
    const { data, body } = parseFrontmatter("---\r\ntitle: X\r\n---\r\nbody\r\n");
    expect(data.title).toBe("X");
    expect(body).toBe("body\r\n");
  });

  it("stringField returns undefined for non-string values", () => {
    expect(stringField({ n: 3 }, "n")).toBeUndefined();
  });
});
