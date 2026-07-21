import { run as defaultRun, type Runner } from "../exec.js";
import { OkhError } from "../errors.js";

/**
 * Thin, typed wrapper around the `git` CLI.
 *
 * Every method funnels through the injected {@link Runner} (defaults to the real
 * `run`), so tests can either drive real git against temp repos or stub it out.
 * Arguments are always passed as an array — never interpolated into a shell.
 */
/**
 * Allowed git transport protocols. Blocks remote helpers such as `ext::`/`fd::`
 * that execute arbitrary commands, as a second layer behind `repoUrlSchema`.
 * `file` is included so local-path clones (and tests) keep working.
 */
const GIT_ALLOW_PROTOCOL = "https:ssh:git:file:http";

export class Git {
  constructor(private readonly runner: Runner = defaultRun) {}

  private async git(args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await this.runner("git", args, {
        ...(cwd ? { cwd } : {}),
        env: { ...process.env, GIT_ALLOW_PROTOCOL, GIT_TERMINAL_PROMPT: "0" },
      });
      return stdout;
    } catch (err) {
      throw new OkhError(
        "GIT_ERROR",
        `git ${args[0]} failed: ${(err as Error).message}`,
      );
    }
  }

  /** Clone `repoUrl` into `dest`, optionally checking out `ref`. */
  async clone(repoUrl: string, dest: string, ref?: string): Promise<void> {
    const args = ["clone"];
    if (ref) args.push("--branch", ref);
    args.push("--", repoUrl, dest);
    await this.git(args);
  }

  /** Initialise a new repo at `cwd` with `main` as the initial branch. */
  async init(cwd: string): Promise<void> {
    await this.git(["init", "-b", "main"], cwd);
  }

  async addRemote(cwd: string, name: string, url: string): Promise<void> {
    await this.git(["remote", "add", name, url], cwd);
  }

  /** True if the working tree has staged or unstaged changes (ignoring untracked-only? no — includes untracked). */
  async isDirty(cwd: string): Promise<boolean> {
    const out = await this.git(["status", "--porcelain"], cwd);
    return out.trim().length > 0;
  }

  async currentBranch(cwd: string): Promise<string> {
    const out = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    return out.trim();
  }

  /**
   * Ahead/behind counts of the current branch relative to its upstream.
   * Returns `null` when the branch has no configured upstream.
   */
  async aheadBehind(cwd: string): Promise<{ ahead: number; behind: number } | null> {
    try {
      const out = await this.git(
        ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        cwd,
      );
      const [behind, ahead] = out.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
      return { ahead: ahead ?? 0, behind: behind ?? 0 };
    } catch {
      return null;
    }
  }

  /**
   * True if any local branch has commits not present on any remote — i.e. work
   * that would be lost on uninstall. Uses `git log --branches --not --remotes`.
   */
  async hasUnpushedCommits(cwd: string): Promise<boolean> {
    const out = await this.git(
      ["log", "--branches", "--not", "--remotes", "--oneline"],
      cwd,
    );
    return out.trim().length > 0;
  }

  /** True if HEAD has commits not present on any remote. */
  async hasCurrentBranchUnpushedCommits(cwd: string): Promise<boolean> {
    const out = await this.git(
      ["log", "HEAD", "--not", "--remotes", "--oneline"],
      cwd,
    );
    return out.trim().length > 0;
  }

  /** Stash all changes (including untracked). Returns true if anything was stashed. */
  async stashPush(cwd: string, message: string): Promise<boolean> {
    const before = await this.git(["stash", "list"], cwd);
    await this.git(["stash", "push", "--include-untracked", "-m", message], cwd);
    const after = await this.git(["stash", "list"], cwd);
    return after.trim().length > before.trim().length;
  }

  async stashPop(cwd: string): Promise<void> {
    await this.git(["stash", "pop"], cwd);
  }

  async pull(cwd: string): Promise<void> {
    await this.git(["pull", "--ff-only"], cwd);
  }

  async fetch(cwd: string): Promise<void> {
    await this.git(["fetch", "--all", "--prune"], cwd);
  }

  async createBranch(cwd: string, name: string): Promise<void> {
    await this.git(["checkout", "-b", name], cwd);
  }

  async checkout(cwd: string, ref: string): Promise<void> {
    await this.git(["checkout", ref], cwd);
  }

  async stageAll(cwd: string): Promise<void> {
    await this.git(["add", "-A"], cwd);
  }

  async commit(cwd: string, message: string): Promise<void> {
    await this.git(["commit", "-m", message], cwd);
  }

  async resetSoft(cwd: string, ref: string): Promise<void> {
    await this.git(["reset", "--soft", ref], cwd);
  }

  /** True if there is anything staged to commit. */
  async hasStagedChanges(cwd: string): Promise<boolean> {
    try {
      await this.git(["diff", "--cached", "--quiet"], cwd);
      return false;
    } catch {
      return true;
    }
  }

  /** Returns the current HEAD commit SHA. */
  async currentCommit(cwd: string): Promise<string> {
    const out = await this.git(["rev-parse", "HEAD"], cwd);
    return out.trim();
  }

  /** Push `branch` to `remote`, setting upstream. */
  async push(cwd: string, remote: string, branch: string): Promise<void> {
    await this.git(["push", "--set-upstream", remote, branch], cwd);
  }

  /**
   * Force-push `branch` to `remote` with lease protection, setting upstream.
   * Required after rebasing an already-pushed branch so the push is rejected
   * if the remote ref moved since our last fetch.
   */
  async pushForceWithLease(cwd: string, remote: string, branch: string): Promise<void> {
    await this.git(["push", "--force-with-lease", "--set-upstream", remote, branch], cwd);
  }

  /** A short diffstat of `worktree` vs `ref` (default HEAD), for change summaries. */
  async diffStat(cwd: string, ref = "HEAD"): Promise<string> {
    return (await this.git(["diff", "--stat", ref], cwd)).trim();
  }

  async defaultRemote(cwd: string): Promise<string> {
    const out = (await this.git(["remote"], cwd)).trim();
    const remotes = out.split(/\r?\n/).filter(Boolean);
    if (remotes.length === 0) {
      throw new OkhError("GIT_ERROR", "Repository has no configured remote.");
    }
    return remotes.includes("origin") ? "origin" : remotes[0]!;
  }

  /** True if `branch` is a syntactically valid git branch name. */
  async isValidBranchName(branch: string): Promise<boolean> {
    try {
      await this.git(["check-ref-format", "--branch", branch]);
      return true;
    } catch {
      return false;
    }
  }

  /** True if `branch` exists as a local branch in `cwd`. */
  async localBranchExists(cwd: string, branch: string): Promise<boolean> {
    try {
      await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
      return true;
    } catch {
      return false;
    }
  }

  /** True if `branch` exists under `remote` in `cwd`. */
  async remoteBranchExists(cwd: string, remote: string, branch: string): Promise<boolean> {
    try {
      await this.git(["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], cwd);
      return true;
    } catch {
      return false;
    }
  }

  /** Fetch `remote` and prune stale remote-tracking branches. */
  async fetchRemote(cwd: string, remote: string): Promise<void> {
    await this.git(["fetch", remote, "--prune"], cwd);
  }

  /** Create and checkout a new `branch` starting from `startPoint`. */
  async createBranchFrom(cwd: string, branch: string, startPoint: string): Promise<void> {
    await this.git(["checkout", "-b", branch, startPoint], cwd);
  }

  /** Create and checkout `branch` tracking `upstream`. */
  async checkoutTracking(cwd: string, branch: string, upstream: string): Promise<void> {
    await this.git(["checkout", "--track", "-b", branch, upstream], cwd);
  }

  /** Rebase the current branch onto `upstream`. */
  async rebase(cwd: string, upstream: string): Promise<void> {
    await this.git(["rebase", upstream], cwd);
  }

  /** Abort an in-progress rebase. */
  async abortRebase(cwd: string): Promise<void> {
    await this.git(["rebase", "--abort"], cwd);
  }

  /** Initialise a new repo at `cwd` with `branch` as the initial branch. */
  async initWithBranch(cwd: string, branch: string): Promise<void> {
    await this.git(["init", "-b", branch], cwd);
  }

  /** Push `refspec` (e.g. `HEAD:refs/heads/master`) directly to `url`. */
  async pushUrl(cwd: string, url: string, refspec: string): Promise<void> {
    await this.git(["push", url, refspec], cwd);
  }

  /** The configured URL of `remote`. */
  async remoteUrl(cwd: string, remote: string): Promise<string> {
    const out = await this.git(["remote", "get-url", remote], cwd);
    return out.trim();
  }
}
