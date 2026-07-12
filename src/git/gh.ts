import { run as defaultRun, type Runner } from "../exec.js";
import { OkhError } from "../errors.js";

/**
 * Thin wrapper around the GitHub `gh` CLI for the two operations OKH needs:
 * creating a pack's origin repo, and opening a PR for a change branch.
 *
 * `gh` handles authentication itself (via `gh auth login`); OKH stores no tokens.
 */
export class Gh {
  constructor(private readonly runner: Runner = defaultRun) {}

  private async gh(args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await this.runner("gh", args, cwd ? { cwd } : {});
      return stdout;
    } catch (err) {
      throw new OkhError(
        "GH_ERROR",
        `gh ${args[0]} failed: ${(err as Error).message}`,
        "Ensure the GitHub CLI is installed and authenticated (`gh auth status`).",
      );
    }
  }

  /**
   * Create a GitHub repository from an existing local clone and push `main`.
   *
   * @returns the created repo's URL.
   */
  async createRepo(options: {
    cwd: string;
    name: string;
    visibility: "public" | "private" | "internal";
    description?: string;
  }): Promise<string> {
    const args = [
      "repo",
      "create",
      options.name,
      `--${options.visibility}`,
      "--source",
      ".",
      "--remote",
      "origin",
      "--push",
    ];
    if (options.description) args.push("--description", options.description);
    await this.gh(args, options.cwd);
    return (await this.gh(["repo", "view", "--json", "url", "-q", ".url"], options.cwd)).trim();
  }

  /**
   * Open a pull request from the current branch into `base`.
   *
   * @returns the PR URL printed by `gh`.
   */
  async createPr(options: {
    cwd: string;
    base?: string;
    head?: string;
    title: string;
    body: string;
  }): Promise<string> {
    const args = ["pr", "create", "--title", options.title, "--body", options.body];
    if (options.base) args.push("--base", options.base);
    if (options.head) args.push("--head", options.head);
    const out = await this.gh(args, options.cwd);
    return out.trim();
  }

  /** Return the GitHub login of the currently authenticated user. */
  async currentLogin(): Promise<string> {
    const out = (await this.gh(["api", "user", "--jq", ".login"])).trim();
    if (!out) {
      throw new OkhError("GH_ERROR", "gh api user returned an empty login — is gh authenticated?");
    }
    return out;
  }

  /**
   * Find the URL of an open PR matching `base` and `head`.
   * Returns `undefined` when no matching PR exists.
   */
  async findOpenPr(options: {
    cwd: string;
    base: string;
    head: string;
  }): Promise<string | undefined> {
    const out = (
      await this.gh(
        [
          "pr",
          "list",
          "--state",
          "open",
          "--base",
          options.base,
          "--head",
          options.head,
          "--json",
          "url",
          "--jq",
          '.[0].url // ""',
        ],
        options.cwd,
      )
    ).trim();
    return out || undefined;
  }
}
