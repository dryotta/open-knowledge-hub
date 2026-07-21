import { OkhError } from "../errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type OpenPrOptions = {
  owner: string;
  repo: string;
  token: string;
  /** Head branch (same-repo), e.g. "okh/wiki-sync/123". */
  head: string;
  /** Base branch, e.g. "main". */
  base: string;
  title: string;
  body: string;
  /** REST API base; defaults to https://api.github.com. Override for GHES/EMU. */
  apiBase?: string;
  /** Injectable fetch for testing; defaults to the global fetch. */
  fetchImpl?: FetchLike;
};

export type OpenPrResult = { number: number; url: string };

const DEFAULT_API_BASE = "https://api.github.com";

function redact(text: string, token: string): string {
  return token ? text.split(token).join("***") : text;
}

/**
 * Open a same-repo pull request via the GitHub REST API. On a 422 "already
 * exists" response, resolves the existing open PR for the head branch instead
 * of failing, so a retried run is idempotent.
 */
export async function openPr(opts: OpenPrOptions): Promise<OpenPrResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) throw new OkhError("GH_ERROR", "No fetch implementation is available to call the GitHub API.");
  const apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "open-knowledge-hub",
  };

  const res = await fetchImpl(`${apiBase}/repos/${opts.owner}/${opts.repo}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: opts.title, head: opts.head, base: opts.base, body: opts.body }),
  });

  if (res.status === 201) {
    const json = (await res.json()) as { number: number; html_url: string };
    return { number: json.number, url: json.html_url };
  }

  const text = await res.text().catch(() => "");
  if (res.status === 422 && /already exists/i.test(text)) {
    const existing = await findOpenPr(opts, fetchImpl, apiBase, headers);
    if (existing) return existing;
  }
  throw new OkhError(
    "GH_ERROR",
    `GitHub API returned ${res.status} opening a pull request for ${opts.owner}/${opts.repo}: ${redact(text, opts.token)}`,
  );
}

async function findOpenPr(
  opts: OpenPrOptions,
  fetchImpl: FetchLike,
  apiBase: string,
  headers: Record<string, string>,
): Promise<OpenPrResult | null> {
  const q = new URLSearchParams({ head: `${opts.owner}:${opts.head}`, base: opts.base, state: "open" });
  const res = await fetchImpl(`${apiBase}/repos/${opts.owner}/${opts.repo}/pulls?${q.toString()}`, { headers });
  if (res.status !== 200) return null;
  const list = (await res.json()) as Array<{ number: number; html_url: string }>;
  const first = list[0];
  return first ? { number: first.number, url: first.html_url } : null;
}
