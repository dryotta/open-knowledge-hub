import { describe, it, expect } from "vitest";
import { loadOkf, loadDiscipline, combineOkf } from "../src/prompts/discipline.js";

describe("discipline loader", () => {
  it("loads a vendored OKF doc", async () => {
    const text = await loadOkf("okf-ask");
    expect(text.length).toBeGreaterThan(0);
  });

  it("loads a new v2 discipline doc", async () => {
    expect(await loadDiscipline("remember")).toMatch(/append/i);
    expect(await loadDiscipline("context")).toMatch(/working set/i);
    expect(await loadDiscipline("reflect")).toMatch(/insight/i);
  });

  it("combineOkf wraps each doc in a named discipline block", async () => {
    const combined = await combineOkf(["okf-ask"]);
    expect(combined).toContain('<discipline name="okf-ask">');
    expect(combined).toContain("</discipline>");
  });
});
