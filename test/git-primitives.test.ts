import { describe, it, expect } from "vitest";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { OkhError } from "../src/errors.js";
import type { Runner, RunResult } from "../src/exec.js";

// ---------------------------------------------------------------------------
// Recording fake Runner
// ---------------------------------------------------------------------------

interface RunCall {
  command: string;
  args: string[];
  cwd?: string;
}

function makeRunner(opts: {
  responses?: Record<string, string>;
  /** Keys are "<command> <args[0]> ... <args[N]>" — matching calls throw. */
  throws?: string[];
}): { runner: Runner; calls: RunCall[] } {
  const { responses = {}, throws = [] } = opts;
  const throwSet = new Set(throws);
  const calls: RunCall[] = [];

  const runner: Runner = async (command, args, options?): Promise<RunResult> => {
    const key = [command, ...args].join(" ");
    calls.push({ command, args: [...args], cwd: options?.cwd });
    if (throwSet.has(key)) {
      throw new Error(`Fake throw: ${key}`);
    }
    return { stdout: responses[key] ?? "", stderr: "" };
  };

  return { runner, calls };
}

// ---------------------------------------------------------------------------
// Git primitives
// ---------------------------------------------------------------------------

describe("Git.isValidBranchName", () => {
  it("returns true when git check-ref-format succeeds", async () => {
    const { runner, calls } = makeRunner({});
    const git = new Git(runner);
    const result = await git.isValidBranchName("feature/my-branch");
    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "git",
      args: ["check-ref-format", "--branch", "feature/my-branch"],
    });
  });

  it("returns false (not OkhError) when git check-ref-format fails", async () => {
    const { runner } = makeRunner({
      throws: ["git check-ref-format --branch bad..name"],
    });
    const git = new Git(runner);
    const result = await git.isValidBranchName("bad..name");
    expect(result).toBe(false);
  });
});

describe("Git.localBranchExists", () => {
  it("returns true when show-ref verify succeeds", async () => {
    const { runner, calls } = makeRunner({});
    const git = new Git(runner);
    const result = await git.localBranchExists("/repo", "main");
    expect(result).toBe(true);
    expect(calls[0]).toMatchObject({
      command: "git",
      args: ["show-ref", "--verify", "--quiet", "refs/heads/main"],
      cwd: "/repo",
    });
  });

  it("returns false when show-ref verify fails (branch absent)", async () => {
    const { runner } = makeRunner({
      throws: ["git show-ref --verify --quiet refs/heads/absent"],
    });
    const git = new Git(runner);
    const result = await git.localBranchExists("/repo", "absent");
    expect(result).toBe(false);
  });
});

describe("Git.remoteBranchExists", () => {
  it("returns true when show-ref verify for remote succeeds", async () => {
    const { runner, calls } = makeRunner({});
    const git = new Git(runner);
    const result = await git.remoteBranchExists("/repo", "origin", "main");
    expect(result).toBe(true);
    expect(calls[0]).toMatchObject({
      command: "git",
      args: ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"],
      cwd: "/repo",
    });
  });

  it("returns false when remote ref is absent", async () => {
    const { runner } = makeRunner({
      throws: ["git show-ref --verify --quiet refs/remotes/origin/absent"],
    });
    const git = new Git(runner);
    const result = await git.remoteBranchExists("/repo", "origin", "absent");
    expect(result).toBe(false);
  });
});

describe("Git.fetchRemote", () => {
  it("calls fetch <remote> --prune with correct cwd", async () => {
    const { runner, calls } = makeRunner({});
    const git = new Git(runner);
    await git.fetchRemote("/repo", "origin");
    expect(calls[0]).toMatchObject({
      command: "git",
      args: ["fetch", "origin", "--prune"],
      cwd: "/repo",
    });
  });

  it("wraps runner errors as OkhError GIT_ERROR", async () => {
    const { runner } = makeRunner({ throws: ["git fetch upstream --prune"] });
    const git = new Git(runner);
    await expect(git.fetchRemote("/repo", "upstream")).rejects.toMatchObject({
      name: "OkhError",
      code: "GIT_ERROR",
    });
  });
});

describe("Git.createBranchFrom", () => {
  it("calls checkout -b <branch> <startPoint> with correct cwd", async () => {
    const { runner, calls } = makeRunner({});
    const git = new Git(runner);
    await git.createBranchFrom("/repo", "feature/x", "origin/main");
    expect(calls[0]).toMatchObject({
      command: "git",
      args: ["checkout", "-b", "feature/x", "origin/main"],
      cwd: "/repo",
    });
  });

  it("wraps runner errors as OkhError GIT_ERROR", async () => {
    const { runner } = makeRunner({
      throws: ["git checkout -b bad origin/main"],
    });
    const git = new Git(runner);
    await expect(git.createBranchFrom("/repo", "bad", "origin/main")).rejects.toMatchObject({
      name: "OkhError",
      code: "GIT_ERROR",
    });
  });
});

describe("Git.checkoutTracking", () => {
  it("calls checkout --track -b <branch> <upstream> with correct cwd", async () => {
    const { runner, calls } = makeRunner({});
    const git = new Git(runner);
    await git.checkoutTracking("/repo", "feature/x", "origin/feature/x");
    expect(calls[0]).toMatchObject({
      command: "git",
      args: ["checkout", "--track", "-b", "feature/x", "origin/feature/x"],
      cwd: "/repo",
    });
  });
});

describe("Git.rebase", () => {
  it("calls rebase <upstream> with correct cwd", async () => {
    const { runner, calls } = makeRunner({});
    const git = new Git(runner);
    await git.rebase("/repo", "origin/main");
    expect(calls[0]).toMatchObject({
      command: "git",
      args: ["rebase", "origin/main"],
      cwd: "/repo",
    });
  });

  it("wraps runner errors as OkhError GIT_ERROR", async () => {
    const { runner } = makeRunner({ throws: ["git rebase origin/main"] });
    const git = new Git(runner);
    await expect(git.rebase("/repo", "origin/main")).rejects.toMatchObject({
      name: "OkhError",
      code: "GIT_ERROR",
    });
  });
});

describe("Git.abortRebase", () => {
  it("calls rebase --abort with correct cwd", async () => {
    const { runner, calls } = makeRunner({});
    const git = new Git(runner);
    await git.abortRebase("/repo");
    expect(calls[0]).toMatchObject({
      command: "git",
      args: ["rebase", "--abort"],
      cwd: "/repo",
    });
  });
});

// ---------------------------------------------------------------------------
// Gh primitives
// ---------------------------------------------------------------------------

describe("Gh.currentLogin", () => {
  it("returns trimmed login from gh api user --jq .login", async () => {
    const { runner, calls } = makeRunner({
      responses: { "gh api user --jq .login": "  octocat\n" },
    });
    const gh = new Gh(runner);
    const login = await gh.currentLogin();
    expect(login).toBe("octocat");
    expect(calls[0]).toMatchObject({
      command: "gh",
      args: ["api", "user", "--jq", ".login"],
    });
  });

  it("throws OkhError GH_ERROR when output is empty", async () => {
    const { runner } = makeRunner({
      responses: { "gh api user --jq .login": "   \n" },
    });
    const gh = new Gh(runner);
    await expect(gh.currentLogin()).rejects.toMatchObject({
      name: "OkhError",
      code: "GH_ERROR",
    });
  });

  it("wraps runner errors as OkhError GH_ERROR", async () => {
    const { runner } = makeRunner({ throws: ["gh api user --jq .login"] });
    const gh = new Gh(runner);
    await expect(gh.currentLogin()).rejects.toMatchObject({
      name: "OkhError",
      code: "GH_ERROR",
    });
  });
});

describe("Gh.findOpenPr", () => {
  it("returns PR URL when pr list returns one", async () => {
    const { runner, calls } = makeRunner({
      responses: {
        "gh pr list --state open --base main --head feature/x --json url --jq .[0].url // \"\"":
          "https://github.com/org/repo/pull/42\n",
      },
    });
    const gh = new Gh(runner);
    const url = await gh.findOpenPr({ cwd: "/repo", base: "main", head: "feature/x" });
    expect(url).toBe("https://github.com/org/repo/pull/42");
    expect(calls[0]).toMatchObject({
      command: "gh",
      args: [
        "pr",
        "list",
        "--state",
        "open",
        "--base",
        "main",
        "--head",
        "feature/x",
        "--json",
        "url",
        "--jq",
        '.[0].url // ""',
      ],
      cwd: "/repo",
    });
  });

  it("returns undefined when pr list returns empty string", async () => {
    const { runner } = makeRunner({
      responses: {
        "gh pr list --state open --base main --head feature/x --json url --jq .[0].url // \"\"": "\n",
      },
    });
    const gh = new Gh(runner);
    const url = await gh.findOpenPr({ cwd: "/repo", base: "main", head: "feature/x" });
    expect(url).toBeUndefined();
  });

  it("wraps runner errors as OkhError GH_ERROR", async () => {
    const { runner } = makeRunner({
      throws: [
        'gh pr list --state open --base main --head feature/x --json url --jq .[0].url // ""',
      ],
    });
    const gh = new Gh(runner);
    await expect(
      gh.findOpenPr({ cwd: "/repo", base: "main", head: "feature/x" }),
    ).rejects.toMatchObject({ name: "OkhError", code: "GH_ERROR" });
  });
});

describe("Gh.createPr", () => {
  it("includes --head when provided", async () => {
    const { runner, calls } = makeRunner({
      responses: {
        "gh pr create --title My PR --body body --base main --head feature/x":
          "https://github.com/org/repo/pull/1\n",
      },
    });
    const gh = new Gh(runner);
    const url = await gh.createPr({
      cwd: "/repo",
      title: "My PR",
      body: "body",
      base: "main",
      head: "feature/x",
    });
    expect(url).toBe("https://github.com/org/repo/pull/1");
    expect(calls[0]).toMatchObject({
      command: "gh",
      args: ["pr", "create", "--title", "My PR", "--body", "body", "--base", "main", "--head", "feature/x"],
      cwd: "/repo",
    });
  });

  it("omits --head when not provided (existing behaviour preserved)", async () => {
    const { runner, calls } = makeRunner({
      responses: {
        "gh pr create --title My PR --body body --base main":
          "https://github.com/org/repo/pull/2\n",
      },
    });
    const gh = new Gh(runner);
    await gh.createPr({ cwd: "/repo", title: "My PR", body: "body", base: "main" });
    expect(calls[0]!.args).not.toContain("--head");
  });

  it("wraps runner errors as OkhError GH_ERROR", async () => {
    const { runner } = makeRunner({
      throws: ["gh pr create --title T --body B"],
    });
    const gh = new Gh(runner);
    await expect(
      gh.createPr({ cwd: "/repo", title: "T", body: "B" }),
    ).rejects.toMatchObject({ name: "OkhError", code: "GH_ERROR" });
  });
});
