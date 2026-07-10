import { describe, it, expect } from "vitest";
import { renderString, resolvePath } from "../src/prompts/templates.js";

const noLoad = async (): Promise<string> => { throw new Error("no includes"); };

describe("resolvePath", () => {
  it("resolves a nested slash-path to a string", () => {
    expect(resolvePath({ skill: { name: "learn" } }, "skill/name")).toBe("learn");
  });
  it("coerces a number leaf to a string", () => {
    expect(resolvePath({ n: 3 }, "n")).toBe("3");
  });
  it("throws on a missing key", () => {
    expect(() => resolvePath({ a: {} }, "a/b")).toThrow(/Unresolvable/);
  });
  it("throws when the leaf is not a string/number", () => {
    expect(() => resolvePath({ a: { b: {} } }, "a")).toThrow(/did not resolve/);
  });
});

describe("renderString", () => {
  it("substitutes var: and config: by slash-path", async () => {
    const out = await renderString(
      "{{var:q}} / {{config:wakePhrase}}",
      { vars: { q: "hi" }, config: { wakePhrase: "sam" } },
      noLoad,
    );
    expect(out).toBe("hi / sam");
  });
  it("resolves nested var paths", async () => {
    const out = await renderString("{{var:skill/name}}", { vars: { skill: { name: "learn" } } }, noLoad);
    expect(out).toBe("learn");
  });
  it("throws on an unknown namespace", async () => {
    await expect(renderString("{{bogus:x}}", {}, noLoad)).rejects.toThrow(/Unknown placeholder namespace/);
  });
  it("throws on a missing var (lockstep)", async () => {
    await expect(renderString("{{var:nope}}", { vars: {} }, noLoad)).rejects.toThrow(/Unresolvable/);
  });
  it("does not re-scan injected values", async () => {
    const out = await renderString("{{var:a}}", { vars: { a: "{{var:b}}" } }, noLoad);
    expect(out).toBe("{{var:b}}");
  });
  it("includes a partial via prompt: sharing the same context", async () => {
    const load = async (p: string): Promise<string> => {
      if (p === "partials/x.md") return "P:{{var:q}}";
      throw new Error("not found");
    };
    const out = await renderString("[{{prompt:partials/x.md}}]", { vars: { q: "hi" } }, load);
    expect(out).toBe("[P:hi]");
  });
  it("throws on an include cycle", async () => {
    const load = async (): Promise<string> => "{{prompt:a.md}}";
    await expect(renderString("{{prompt:a.md}}", {}, load)).rejects.toThrow(/cycle/);
  });
});
