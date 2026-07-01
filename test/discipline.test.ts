import { describe, it, expect } from "vitest";
import {
  loadDiscipline,
  buildAskFlow,
  buildLearnFlow,
  buildReviewUpdateFlow,
  buildCreateFlow,
} from "../src/discipline/index.js";

describe("discipline loading", () => {
  it("loads vendored OKF docs", async () => {
    expect(await loadDiscipline("OKF-FORMAT")).toContain("OKF Format");
    expect(await loadDiscipline("okf-ask")).toContain("OKF Ask");
  });
});

describe("flow builders", () => {
  it("ask flow embeds pack context and okf-ask discipline", async () => {
    const out = await buildAskFlow({ slug: "billing", localPath: "/tmp/p", question: "How does X work?" });
    expect(out).toContain("billing");
    expect(out).toContain("/tmp/p");
    expect(out).toContain("How does X work?");
    expect(out).toContain("OKF Ask");
  });

  it("learn flow includes the PR write policy and disciplines", async () => {
    const out = await buildLearnFlow({ slug: "billing", localPath: "/tmp/p" });
    expect(out).toContain("pack_begin_change");
    expect(out).toContain("pull request");
    expect(out).toContain("OKF Learn");
    expect(out).toContain("OKF Format");
  });

  it("review_update flow references the scope contract and write policy", async () => {
    const out = await buildReviewUpdateFlow({ slug: "billing", localPath: "/tmp/p" });
    expect(out).toContain("scope contract");
    expect(out).toContain("pack_open_pr");
  });

  it("create flow includes scaffold/publish policy", async () => {
    const out = await buildCreateFlow({ slug: "new-pack" });
    expect(out).toContain("pack_create");
    expect(out).toContain("pack_publish");
    expect(out).toContain("Repo → OKF");
  });
});
