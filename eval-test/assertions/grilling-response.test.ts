import { describe, expect, it } from "vitest";
import grillingResponse from "../../eval/assertions/grilling-response.js";

const evaluate = (finalMessage?: string) =>
  grillingResponse("", { providerResponse: { metadata: { finalMessage } } });

describe("grilling-response assertion", () => {
  it("accepts one plan-specific question with a recommendation", () => {
    const result = evaluate(
      "Which OAuth callback origins should be trusted?\n\n*Recommendation:* Start with the callback boundary.",
    );
    expect(result.pass).toBe(true);
  });

  it("accepts a framing question plus one same-topic decision question", () => {
    const result = evaluate(
      "Why GitHub OAuth? Are your users primarily developers? My recommendation is GitHub-only for a developer audience.",
    );
    expect(result.pass).toBe(true);
  });

  it("accepts three tightly related questions about one provider decision", () => {
    const result = evaluate(
      "Why GitHub? Are your users GitHub developers? Will other OAuth providers follow? My recommendation is GitHub-only first.",
    );
    expect(result.pass).toBe(true);
  });

  it("rejects bundled decisions", () => {
    const result = evaluate(
      "Which OAuth tokens are stored? Do you need refresh tokens? Which session backend will you use? My recommendation is to start with token storage.",
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/span 2 decision topics/i);
  });

  it("rejects a repetitive four-question prompt even within one topic", () => {
    const result = evaluate(
      "Why GitHub? Are users on GitHub? Will Google follow? Is GitLab needed? My recommendation is GitHub-only first.",
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/compact decision prompt.*found 4/i);
  });

  it("requires both a recommendation and plan relevance", () => {
    expect(evaluate("What decision comes first?").pass).toBe(false);
    expect(evaluate("Which OAuth flow comes first?").reason).toMatch(/recommendation/i);
  });

  it("rejects a missing final message", () => {
    expect(evaluate().reason).toMatch(/missing or empty/i);
  });
});
