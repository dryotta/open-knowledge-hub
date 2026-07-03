import { describe, it, expect } from "vitest";
import { extractToolCalls } from "../eval/copilot.js";

describe("extractToolCalls", () => {
  it("detects a server-qualified tool call", () => {
    expect(extractToolCalls("Calling open-knowledge-hub__ask with {q}")).toEqual(["ask"]);
  });
  it("detects a dotted qualified call and a parenthesized call", () => {
    expect(extractToolCalls("invoked open-knowledge-hub.sync() now")).toEqual(["sync"]);
    expect(extractToolCalls("ran learn( container )")).toEqual(["learn"]);
  });
  it("returns a sorted unique set and ignores prose", () => {
    expect(extractToolCalls("open-knowledge-hub__remember then open-knowledge-hub__ask; will add a note"))
      .toEqual(["ask", "remember"]);
  });
  it("returns empty when no tools are referenced", () => {
    expect(extractToolCalls("just some text about knowledge")).toEqual([]);
  });
});
