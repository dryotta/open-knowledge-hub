import { z } from "zod";
import { OkhError } from "../errors.js";
import { repoUrlSchema } from "../registry/schema.js";
import type { SyncMode } from "../registry/schema.js";
import type { Git } from "../git/git.js";
import type { Gh } from "../git/gh.js";
import type {
  SyncBackend,
  SyncSelection,
  ResolveSyncContext,
  BackendSyncRequest,
  BackendSyncResult,
} from "./types.js";

const backendConfigSchema = z.object({ origin: repoUrlSchema }).strict();
const autoConfigSchema = z.object({}).strict();
const sharedInputConfigSchema = z.object({ branch: z.string().optional() }).strict();

/**
 * SyncBackend for git-hosted containers.
 *
 * Supports two modes:
 * - `auto`: commit all local changes, `pull --ff-only`, push to `origin`.
 * - `shared`: maintain a persistent shared branch (defaults to `user/<login>/hub`),
 *   rebase it onto `origin/main` on each sync, and optionally open a PR.
 *
 * Both `Git` and `Gh` are injected so tests can drive real temp repos with a
 * fake `Gh`, or stub `Git` for error-path testing.
 */
export class GitBackend implements SyncBackend {
  readonly type = "git" as const;
  readonly modes: readonly SyncMode[] = ["auto", "shared"];

  constructor(
    private readonly git: Git,
    private readonly gh: Gh,
  ) {}

  resolveBackendConfig(config: unknown): Record<string, unknown> {
    const result = backendConfigSchema.safeParse(config);
    if (!result.success) {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Backend config for "git" is invalid: ${result.error.issues[0]?.message ?? result.error.message}`,
      );
    }
    return result.data;
  }

  async resolveSync(
    selection: SyncSelection,
    _context: ResolveSyncContext,
  ): Promise<SyncSelection> {
    if (selection.mode === "auto") {
      const result = autoConfigSchema.safeParse(selection.config);
      if (!result.success) {
        throw new OkhError(
          "INVALID_ARGUMENT",
          `Sync config for "git" auto mode must be empty: ${result.error.issues[0]?.message ?? result.error.message}`,
        );
      }
      return { mode: "auto", config: {} };
    }

    // shared
    const result = sharedInputConfigSchema.safeParse(selection.config);
    if (!result.success) {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Sync config for "git" shared mode is invalid: ${result.error.issues[0]?.message ?? result.error.message}`,
      );
    }

    let branch = result.data.branch;
    if (!branch) {
      let login: string;
      try {
        login = await this.gh.currentLogin();
      } catch (err) {
        throw new OkhError(
          "GH_ERROR",
          `Cannot determine default shared branch: ${(err as Error).message}`,
          "Run `gh auth login` to authenticate, or specify an explicit branch name.",
        );
      }
      branch = `user/${login}/hub`;
    }

    if (branch === "main") {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Shared sync branch cannot be "main". Choose a different branch name.`,
      );
    }

    const valid = await this.git.isValidBranchName(branch);
    if (!valid) {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `"${branch}" is not a valid git branch name.`,
      );
    }

    return { mode: "shared", config: { branch } };
  }

  actions(selection: SyncSelection): readonly string[] {
    return selection.mode === "shared" ? ["publish-pr"] : [];
  }

  async sync(request: BackendSyncRequest): Promise<BackendSyncResult> {
    if (request.entry.sync.mode === "auto") {
      return this.syncAuto(request);
    }
    return this.syncShared(request);
  }

  private async syncAuto(request: BackendSyncRequest): Promise<BackendSyncResult> {
    const { entry, message, action } = request;
    const root = entry.localPath;

    if (action !== undefined) {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Git backend "auto" mode does not support actions (got "${action}"). No actions are available for this mode.`,
      );
    }

    // Fetch first so the remote-tracking refs are current; `aheadBehind` then
    // gives an accurate `behind` count rather than the stale value from the last
    // fetch. The subsequent `pull --ff-only` does its own fetch again, which is
    // a no-op when nothing new has arrived between these two calls.
    await this.git.fetchRemote(root, "origin");
    const ab = await this.git.aheadBehind(root);
    const hadRemoteWork = ab !== null && ab.behind > 0;

    await this.git.stageAll(root);
    let committed = false;
    if (await this.git.hasStagedChanges(root)) {
      await this.git.commit(root, message ?? `okh: sync ${entry.name}`);
      committed = true;
    }

    try {
      await this.git.pull(root);
    } catch (err) {
      throw new OkhError(
        "GIT_ERROR",
        `sync pull failed for "${entry.name}": ${(err as Error).message}`,
        "The branch may have diverged from its upstream. Resolve manually (e.g. git pull --rebase) then retry.",
      );
    }

    const branch = await this.git.currentBranch(root);
    await this.git.push(root, "origin", branch);

    const outcome = committed || hadRemoteWork ? "synced" : "up-to-date";
    return { mode: "auto", outcome, committed, pushed: true, branch };
  }

  private async ensureSharedBranch(root: string, branch: string): Promise<void> {
    await this.git.fetchRemote(root, "origin");
    if (await this.git.localBranchExists(root, branch)) {
      await this.git.checkout(root, branch);
    } else if (await this.git.remoteBranchExists(root, "origin", branch)) {
      await this.git.checkoutTracking(root, branch, `origin/${branch}`);
    } else {
      await this.git.createBranchFrom(root, branch, "origin/main");
    }
  }

  private async syncShared(request: BackendSyncRequest): Promise<BackendSyncResult> {
    const { entry, message, action } = request;
    const root = entry.localPath;
    // `resolveSync` always persists `{ branch: string }` in the shared config and
    // `BackendRegistry.validateEntry` enforces this invariant before any sync.
    const { branch } = entry.sync.config as { branch: string };

    if (action !== undefined && action !== "publish-pr") {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Git backend "shared" mode received unknown action "${action}". Supported actions: publish-pr.`,
      );
    }

    await this.ensureSharedBranch(root, branch);

    await this.git.stageAll(root);
    let committed = false;
    if (await this.git.hasStagedChanges(root)) {
      await this.git.commit(root, message ?? `okh: sync ${entry.name}`);
      committed = true;
    }

    await this.git.fetchRemote(root, "origin");

    try {
      await this.git.rebase(root, "origin/main");
    } catch (rebaseErr) {
      try {
        await this.git.abortRebase(root);
      } catch (abortErr) {
        throw new AggregateError(
          [rebaseErr, abortErr],
          `Rebase failed and abort also failed. Rebase: ${(rebaseErr as Error).message}. Abort: ${(abortErr as Error).message}`,
        );
      }
      throw new OkhError(
        "GIT_ERROR",
        `Shared sync rebase failed for "${entry.name}": ${(rebaseErr as Error).message}`,
        "Your local commit is preserved on the shared branch. Resolve conflicts manually, then re-run sync.",
      );
    }

    await this.git.push(root, "origin", branch);

    if (action !== "publish-pr") {
      return { mode: "shared", outcome: "synced", committed, pushed: true, branch };
    }

    // publish-pr: find existing or create new PR
    const existingPr = await this.gh.findOpenPr({ cwd: root, base: "main", head: branch });
    let prUrl: string;
    if (existingPr) {
      prUrl = existingPr;
    } else {
      prUrl = await this.gh.createPr({
        cwd: root,
        base: "main",
        head: branch,
        title: message ?? `okh sync: ${entry.name}`,
        body: "Automated OKH sync.",
      });
    }

    return {
      mode: "shared",
      requestedAction: "publish-pr",
      outcome: "published",
      committed,
      pushed: true,
      branch,
      prUrl,
    };
  }
}
