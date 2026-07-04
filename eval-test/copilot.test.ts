import { describe, it, expect } from "vitest";
import { extractToolCalls } from "../eval/copilot.js";

describe("extractToolCalls", () => {
  it("detects tools from real Copilot CLI MCP-call lines", () => {
    const transcript = [
      '● Remember (flow) (MCP: open-knowledge-hub) · container: "kb-hub", observation: "…"',
      "  └ # OKH: remember",
      '● Sync containers (MCP: open-knowledge-hub) · container: "kb-hub", message: "…"',
    ].join("\n");
    expect(extractToolCalls(transcript)).toEqual(["remember", "sync"]);
  });
  it("detects onboard from a real Copilot CLI MCP-call line", () => {
    const transcript = "● Onboard (guided setup) (MCP: open-knowledge-hub)";
    expect(extractToolCalls(transcript)).toEqual(["onboard"]);
  });
  it("detects config from a real Copilot CLI MCP-call line", () => {
    const transcript = "● Config (view or change settings) (MCP: open-knowledge-hub) · set: {…}";
    expect(extractToolCalls(transcript)).toEqual(["config"]);
  });
  it("does not treat add's config/sync arguments as separate tool calls", () => {
    const transcript =
      '● Add a container or module (MCP: open-knowledge-hub) · container: "notes", path: "kb", type: "knowledge", config: {…}, sync: "auto"';
    expect(extractToolCalls(transcript)).toEqual(["add"]);
  });
  it("detects a server-qualified tool call (fallback rendering)", () => {
    expect(extractToolCalls("Calling open-knowledge-hub__ask with {q}")).toEqual(["ask"]);
    expect(extractToolCalls("invoked open-knowledge-hub.sync now")).toEqual(["sync"]);
  });
  it("returns a sorted unique set and does not false-positive on prose", () => {
    expect(extractToolCalls("open-knowledge-hub__remember then open-knowledge-hub__ask; will add a note"))
      .toEqual(["ask", "remember"]);
  });
  it("does not match a tool name that only appears in prose (not an MCP line)", () => {
    expect(extractToolCalls("The agent will add a note and ask the user about context.")).toEqual([]);
  });
  it("returns empty when no tools are referenced", () => {
    expect(extractToolCalls("just some text about knowledge")).toEqual([]);
  });
});
