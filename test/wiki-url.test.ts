import { describe, it, expect } from "vitest";
import { parseGitHubRepo, isGitHubOrigin, repoBrowseUrl, wikiRemoteUrl } from "../src/wiki/url.js";

describe("parseGitHubRepo", () => {
  it("parses https with .git", () => {
    expect(parseGitHubRepo("https://github.com/acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
  });
  it("parses https without .git", () => {
    expect(parseGitHubRepo("https://github.com/acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
  });
  it("parses scp-style git@ url", () => {
    expect(parseGitHubRepo("git@github.com:acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
  });
  it("parses ssh:// url", () => {
    expect(parseGitHubRepo("ssh://git@github.com/acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
  });
  it("returns undefined for non-github host", () => {
    expect(parseGitHubRepo("https://gitlab.com/acme/widgets.git")).toBeUndefined();
  });
  it("returns undefined for a filesystem origin", () => {
    expect(parseGitHubRepo("file:///tmp/origin")).toBeUndefined();
  });
});

describe("helpers", () => {
  it("isGitHubOrigin is true for github", () => {
    expect(isGitHubOrigin("git@github.com:acme/widgets.git")).toBe(true);
    expect(isGitHubOrigin("file:///tmp/x")).toBe(false);
  });
  it("builds browse and wiki urls", () => {
    const r = { owner: "acme", repo: "widgets" };
    expect(repoBrowseUrl(r)).toBe("https://github.com/acme/widgets");
    expect(wikiRemoteUrl(r)).toBe("https://github.com/acme/widgets.wiki.git");
  });
});
