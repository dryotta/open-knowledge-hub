import { describe, it, expect } from "vitest";
import { openPr, type FetchLike } from "../src/wiki/github.js";

type Call = { url: string; init?: RequestInit };

function recorder(handlers: ((call: Call) => Response | undefined)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    for (const h of handlers) {
      const r = h(call);
      if (r) return r;
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { fetch, calls };
}

const base = {
  owner: "acme",
  repo: "widgets",
  token: "sekret-token",
  head: "okh/wiki-sync/123",
  base: "main",
  title: "Sync wiki edits",
  body: "A/M/R/D summary",
};

describe("openPr", () => {
  it("POSTs to the pulls endpoint with auth + payload and returns number/url", async () => {
    const { fetch, calls } = recorder([
      (c) =>
        c.init?.method === "POST"
          ? new Response(JSON.stringify({ number: 7, html_url: "https://github.com/acme/widgets/pull/7" }), { status: 201 })
          : undefined,
    ]);
    const res = await openPr({ ...base, fetchImpl: fetch });
    expect(res).toEqual({ number: 7, url: "https://github.com/acme/widgets/pull/7" });
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/widgets/pulls");
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sekret-token");
    expect(headers.Accept).toBe("application/vnd.github+json");
    const payload = JSON.parse(calls[0].init!.body as string);
    expect(payload).toEqual({ title: base.title, head: base.head, base: base.base, body: base.body });
  });

  it("honours an apiBase override", async () => {
    const { fetch, calls } = recorder([
      () => new Response(JSON.stringify({ number: 1, html_url: "u" }), { status: 201 }),
    ]);
    await openPr({ ...base, apiBase: "https://api.github.example.com/", fetchImpl: fetch });
    expect(calls[0].url).toBe("https://api.github.example.com/repos/acme/widgets/pulls");
  });

  it("resolves an existing PR on a 422 already-exists response", async () => {
    const { fetch } = recorder([
      (c) =>
        c.init?.method === "POST"
          ? new Response(JSON.stringify({ message: "A pull request already exists for acme:okh/wiki-sync/123." }), { status: 422 })
          : undefined,
      (c) =>
        c.url.includes("state=open")
          ? new Response(JSON.stringify([{ number: 9, html_url: "https://github.com/acme/widgets/pull/9" }]), { status: 200 })
          : undefined,
    ]);
    const res = await openPr({ ...base, fetchImpl: fetch });
    expect(res).toEqual({ number: 9, url: "https://github.com/acme/widgets/pull/9" });
  });

  it("throws GH_ERROR with a redacted token on a non-2xx response", async () => {
    const { fetch } = recorder([
      () => new Response(`bad credentials for sekret-token`, { status: 403 }),
    ]);
    await expect(openPr({ ...base, fetchImpl: fetch })).rejects.toMatchObject({
      code: "GH_ERROR",
    });
    await expect(openPr({ ...base, fetchImpl: fetch })).rejects.toThrow(/403/);
    await expect(openPr({ ...base, fetchImpl: fetch })).rejects.not.toThrow(/sekret-token/);
  });
});
