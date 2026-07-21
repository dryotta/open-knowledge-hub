export type GitHubRepo = { owner: string; repo: string };

const stripGit = (s: string): string => (s.endsWith(".git") ? s.slice(0, -4) : s);

export function parseGitHubRepo(origin: string): GitHubRepo | undefined {
  const trimmed = origin.trim();
  // scp-style: git@github.com:owner/repo(.git)
  const scp = /^[^@]+@github\.com:([^/]+)\/(.+)$/.exec(trimmed);
  if (scp) return { owner: scp[1], repo: stripGit(scp[2]) };
  // url form: https:// or ssh://
  try {
    const u = new URL(trimmed);
    if (u.hostname !== "github.com") return undefined;
    const parts = u.pathname.replace(/^\/+/, "").split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
    return { owner: parts[0], repo: stripGit(parts[1]) };
  } catch {
    return undefined;
  }
}

export function isGitHubOrigin(origin: string): boolean {
  return parseGitHubRepo(origin) !== undefined;
}

export function repoBrowseUrl(r: GitHubRepo): string {
  return `https://github.com/${r.owner}/${r.repo}`;
}

export function wikiRemoteUrl(r: GitHubRepo): string {
  return `https://github.com/${r.owner}/${r.repo}.wiki.git`;
}
