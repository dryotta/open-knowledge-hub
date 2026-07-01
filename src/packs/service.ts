import { mkdir, rm, stat, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { OkhPaths } from "../config.js";
import { packCloneDir } from "../config.js";
import { OkhError } from "../errors.js";
import { Git } from "../git/git.js";
import { Gh } from "../git/gh.js";
import {
  findPack,
  loadManifest,
  requirePack,
  saveManifest,
  withPackAdded,
  withPackRemoved,
  withPackUpdated,
} from "../catalog/manifest.js";
import type { PackEntry } from "../catalog/schema.js";
import { slugSchema, subpathSchema, repoUrlSchema, resolveSubpath } from "../catalog/schema.js";
import { Mutex } from "../util/mutex.js";
import { resolve, relative } from "node:path";
import type { ZodType } from "zod";

/** Validate `value` against `schema`, converting a ZodError into a clean OkhError. */
function validate<T>(schema: ZodType<T>, value: unknown, field: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new OkhError(
      "INVALID_ARGUMENT",
      `Invalid ${field}: ${result.error.issues[0]?.message ?? result.error.message}`,
    );
  }
  return result.data;
}

export interface AddPackInput {
  slug: string;
  repoUrl: string;
  subpath?: string;
  ref?: string;
}

export interface PackStatus {
  slug: string;
  installed: boolean;
  branch?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  hasUnpushedCommits?: boolean;
  localPath?: string;
}

/**
 * High-level operations over the catalog. Combines the manifest (state),
 * git (working trees), and gh (remote) layers. Every method loads and saves the
 * manifest so the on-disk catalog is always the source of truth.
 */
export class PackService {
  /** Serializes catalog read-modify-write sequences across concurrent tool calls. */
  private readonly mutex = new Mutex();

  constructor(
    private readonly paths: OkhPaths,
    private readonly git: Git = new Git(),
    private readonly gh: Gh = new Gh(),
  ) {}

  /** Absolute path to the git clone (repo root) for a slug. */
  private cloneDir(slug: string): string {
    return packCloneDir(this.paths, slug);
  }

  /**
   * Absolute path to the pack root (clone root, or `clone/subpath`). Verifies the
   * resolved root stays within the clone directory — defence-in-depth against a
   * traversal subpath that somehow bypassed schema validation.
   */
  private packRoot(entry: PackEntry): string {
    const clone = this.cloneDir(entry.slug);
    if (!entry.subpath) return clone;
    const root = resolve(clone, entry.subpath);
    const rel = relative(clone, root);
    if (rel.startsWith("..") || resolve(clone, rel) !== root) {
      throw new OkhError("INVALID_ARGUMENT", `subpath "${entry.subpath}" escapes the pack directory.`);
    }
    return root;
  }

  async list(): Promise<PackEntry[]> {
    const manifest = await loadManifest(this.paths);
    return manifest.packs;
  }

  /** Register a pack without installing it. */
  add(input: AddPackInput): Promise<PackEntry> {
    return this.mutex.run(() => this.addImpl(input));
  }

  private async addImpl(input: AddPackInput): Promise<PackEntry> {
    validate(slugSchema, input.slug, "slug");
    validate(repoUrlSchema, input.repoUrl, "repoUrl");
    const subpath = resolveSubpath(input.subpath);
    if (subpath !== undefined) validate(subpathSchema, subpath, "subpath");
    const manifest = await loadManifest(this.paths);
    const entry: PackEntry = {
      slug: input.slug,
      repoUrl: input.repoUrl,
      ...(subpath ? { subpath } : {}),
      ...(input.ref ? { ref: input.ref } : {}),
      state: "registered",
      addedAt: new Date().toISOString(),
    };
    await saveManifest(this.paths, withPackAdded(manifest, entry));
    return entry;
  }

  /**
   * Clone a registered pack's origin into `packs/<slug>` and mark it installed.
   * If the pack is not yet registered, it may be added inline via `input`.
   */
  install(slug: string, input?: AddPackInput): Promise<PackEntry> {
    return this.mutex.run(() => this.installImpl(slug, input));
  }

  private async installImpl(slug: string, input?: AddPackInput): Promise<PackEntry> {
    let manifest = await loadManifest(this.paths);
    let entry = findPack(manifest, slug);

    if (!entry) {
      if (!input) {
        throw new OkhError("NOT_FOUND", `No pack named "${slug}" in the catalog. Register it first with catalog_add, or pass origin details.`);
      }
      entry = await this.addImpl(input);
      manifest = await loadManifest(this.paths);
    }

    if (entry.state === "installed") {
      throw new OkhError("ALREADY_INSTALLED", `Pack "${slug}" is already installed.`);
    }

    const clone = this.cloneDir(slug);
    await this.assertCloneDirAvailable(clone);
    await mkdir(this.paths.packsDir, { recursive: true });

    try {
      await this.git.clone(entry.repoUrl, clone, entry.ref);
    } catch (err) {
      await rm(clone, { recursive: true, force: true });
      throw err;
    }

    const root = this.packRoot(entry);
    if (entry.subpath) {
      await this.assertSubpathExists(root, clone, slug, entry.subpath);
    }

    const updated: PackEntry = {
      ...entry,
      state: "installed",
      localPath: root,
      installedAt: new Date().toISOString(),
    };
    await saveManifest(this.paths, withPackUpdated(manifest, slug, () => updated));
    return updated;
  }

  /** Resolve the local pack-root path for an installed pack. */
  async path(slug: string): Promise<string> {
    const manifest = await loadManifest(this.paths);
    const entry = requirePack(manifest, slug);
    this.assertInstalled(entry);
    return this.packRoot(entry);
  }

  /** Git status of an installed pack. Registered-only packs report installed=false. */
  async status(slug: string): Promise<PackStatus> {
    const manifest = await loadManifest(this.paths);
    const entry = requirePack(manifest, slug);
    if (entry.state !== "installed") {
      return { slug, installed: false };
    }
    const clone = this.cloneDir(slug);
    const [branch, dirty, ab, unpushed] = await Promise.all([
      this.git.currentBranch(clone),
      this.git.isDirty(clone),
      this.git.aheadBehind(clone),
      this.git.hasUnpushedCommits(clone),
    ]);
    return {
      slug,
      installed: true,
      branch,
      dirty,
      ahead: ab?.ahead ?? 0,
      behind: ab?.behind ?? 0,
      hasUnpushedCommits: unpushed,
      localPath: this.packRoot(entry),
    };
  }

  /**
   * Refresh an installed pack from origin. Local changes are auto-stashed before
   * the pull and restored afterwards, so uncommitted work is preserved.
   */
  pull(slug: string): Promise<{ stashed: boolean }> {
    return this.mutex.run(() => this.pullImpl(slug));
  }

  private async pullImpl(slug: string): Promise<{ stashed: boolean }> {
    const manifest = await loadManifest(this.paths);
    const entry = requirePack(manifest, slug);
    this.assertInstalled(entry);
    const clone = this.cloneDir(slug);

    const stashed = await this.git.stashPush(clone, "okh-auto-stash");
    try {
      await this.git.pull(clone);
    } finally {
      if (stashed) {
        await this.git.stashPop(clone);
      }
    }
    return { stashed };
  }

  /**
   * Remove a pack's local clone. Blocks when there are unpushed commits unless
   * `force` is set. When `purge` is true the catalog entry is deleted; otherwise
   * it reverts to `registered` so the pack can be reinstalled later.
   */
  uninstall(slug: string, options: { force?: boolean; purge?: boolean } = {}): Promise<void> {
    return this.mutex.run(() => this.uninstallImpl(slug, options));
  }

  private async uninstallImpl(slug: string, options: { force?: boolean; purge?: boolean }): Promise<void> {
    const manifest = await loadManifest(this.paths);
    const entry = requirePack(manifest, slug);

    if (entry.state === "installed") {
      const clone = this.cloneDir(slug);
      if (!options.force && (await this.git.hasUnpushedCommits(clone))) {
        throw new OkhError(
          "UNPUSHED_COMMITS",
          `Pack "${slug}" has commits that are not on any remote. Push/open a PR first, or pass force to discard them.`,
        );
      }
      await rm(clone, { recursive: true, force: true });
    }

    if (options.purge) {
      await saveManifest(this.paths, withPackRemoved(manifest, slug));
      return;
    }
    await saveManifest(
      this.paths,
      withPackUpdated(manifest, slug, (e) => {
        const { localPath: _localPath, installedAt: _installedAt, ...rest } = e;
        return { ...rest, state: "registered" };
      }),
    );
  }

  /**
   * Scaffold a brand-new pack locally: create the working dir, `git init`, write
   * a minimal OKF skeleton, make the initial commit, and register it as installed
   * (unpublished — `repoUrl` is a local placeholder until {@link publish}).
   */
  create(input: {
    slug: string;
    title?: string;
    description?: string;
    subpath?: string;
  }): Promise<PackEntry> {
    return this.mutex.run(() => this.createImpl(input));
  }

  private async createImpl(input: {
    slug: string;
    title?: string;
    description?: string;
    subpath?: string;
  }): Promise<PackEntry> {
    validate(slugSchema, input.slug, "slug");
    const subpath = resolveSubpath(input.subpath);
    if (subpath !== undefined) validate(subpathSchema, subpath, "subpath");
    const manifest = await loadManifest(this.paths);
    if (findPack(manifest, input.slug)) {
      throw new OkhError("ALREADY_EXISTS", `A pack named "${input.slug}" already exists.`);
    }

    const clone = this.cloneDir(input.slug);
    await this.assertCloneDirAvailable(clone);
    await mkdir(this.paths.packsDir, { recursive: true });
    const root = subpath ? resolve(clone, subpath) : clone;
    await mkdir(root, { recursive: true });

    await writeFile(join(root, "index.md"), scaffoldIndex(input), "utf8");

    await this.git.init(clone);
    await this.git.stageAll(clone);
    await this.git.commit(clone, `chore: scaffold ${input.slug} knowledge pack`);

    const entry: PackEntry = {
      slug: input.slug,
      repoUrl: `file://${clone}`,
      ...(subpath ? { subpath } : {}),
      state: "installed",
      localPath: root,
      addedAt: new Date().toISOString(),
      installedAt: new Date().toISOString(),
    };
    await saveManifest(this.paths, withPackAdded(manifest, entry));
    return entry;
  }

  /**
   * Publish a locally-created pack to a fresh GitHub repo and push `main`.
   * This is the one direct-to-main push (nothing exists to review against yet).
   */
  publish(input: {
    slug: string;
    repoName: string;
    visibility?: "public" | "private" | "internal";
    description?: string;
  }): Promise<{ entry: PackEntry; repoUrl: string }> {
    return this.mutex.run(() => this.publishImpl(input));
  }

  private async publishImpl(input: {
    slug: string;
    repoName: string;
    visibility?: "public" | "private" | "internal";
    description?: string;
  }): Promise<{ entry: PackEntry; repoUrl: string }> {
    const manifest = await loadManifest(this.paths);
    const entry = requirePack(manifest, input.slug);
    this.assertInstalled(entry);
    const clone = this.cloneDir(input.slug);

    const repoUrl = await this.gh.createRepo({
      cwd: clone,
      name: input.repoName,
      visibility: input.visibility ?? "private",
      ...(input.description ? { description: input.description } : {}),
    });

    const updated = { ...entry, repoUrl };
    await saveManifest(this.paths, withPackUpdated(manifest, input.slug, () => updated));
    return { entry: updated, repoUrl };
  }

  /**
   * Start a change: create the working branch `okh/<slug>/<topic>` off the current
   * branch. Refuses if the working tree is dirty (commit or stash first).
   */
  beginChange(slug: string, topic: string): Promise<{ branch: string; localPath: string }> {
    return this.mutex.run(() => this.beginChangeImpl(slug, topic));
  }

  private async beginChangeImpl(slug: string, topic: string): Promise<{ branch: string; localPath: string }> {
    const manifest = await loadManifest(this.paths);
    const entry = requirePack(manifest, slug);
    this.assertInstalled(entry);
    const clone = this.cloneDir(slug);

    if (await this.git.isDirty(clone)) {
      throw new OkhError(
        "DIRTY_WORKTREE",
        `Pack "${slug}" has uncommitted changes. Commit or discard them before starting a new change.`,
      );
    }
    const branch = `okh/${slug}/${sanitizeTopic(topic)}`;
    await this.git.createBranch(clone, branch);
    return { branch, localPath: this.packRoot(entry) };
  }

  /** Stage all changes and commit them. Throws if there is nothing to commit. */
  commit(slug: string, message: string): Promise<void> {
    return this.mutex.run(() => this.commitImpl(slug, message));
  }

  private async commitImpl(slug: string, message: string): Promise<void> {
    const manifest = await loadManifest(this.paths);
    const entry = requirePack(manifest, slug);
    this.assertInstalled(entry);
    const clone = this.cloneDir(slug);
    await this.git.stageAll(clone);
    if (!(await this.git.hasStagedChanges(clone))) {
      throw new OkhError("INVALID_ARGUMENT", `Pack "${slug}" has no changes to commit.`);
    }
    await this.git.commit(clone, message);
  }

  /** A diffstat of the working tree/commits for a change summary. */
  async diffStat(slug: string, ref = "HEAD"): Promise<string> {
    const manifest = await loadManifest(this.paths);
    const entry = requirePack(manifest, slug);
    this.assertInstalled(entry);
    return this.git.diffStat(this.cloneDir(slug), ref);
  }

  /**
   * Push the current branch and open a PR into the pack's default branch.
   * Returns the PR URL. Never pushes to the default branch directly.
   */
  openPr(slug: string, title: string, body: string): Promise<{ prUrl: string; branch: string }> {
    return this.mutex.run(() => this.openPrImpl(slug, title, body));
  }

  private async openPrImpl(slug: string, title: string, body: string): Promise<{ prUrl: string; branch: string }> {
    const manifest = await loadManifest(this.paths);
    const entry = requirePack(manifest, slug);
    this.assertInstalled(entry);
    const clone = this.cloneDir(slug);

    const branch = await this.git.currentBranch(clone);
    if (branch === "main" || branch === "master") {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Refusing to open a PR from the default branch "${branch}". Start a change branch first (pack_begin_change).`,
      );
    }
    const remote = await this.git.defaultRemote(clone);
    await this.git.push(clone, remote, branch);
    const prUrl = await this.gh.createPr({ cwd: clone, title, body });
    return { prUrl, branch };
  }

  // --- guards -------------------------------------------------------------

  private assertInstalled(entry: PackEntry): void {
    if (entry.state !== "installed") {
      throw new OkhError("NOT_INSTALLED", `Pack "${entry.slug}" is not installed. Install it first.`);
    }
  }

  private async assertCloneDirAvailable(clone: string): Promise<void> {
    try {
      const entries = await readdir(clone);
      if (entries.length > 0) {
        throw new OkhError(
          "ALREADY_EXISTS",
          `Target directory ${clone} already exists and is not empty.`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private async assertSubpathExists(
    root: string,
    clone: string,
    slug: string,
    subpath: string,
  ): Promise<void> {
    try {
      const s = await stat(root);
      if (!s.isDirectory()) throw new Error("not a directory");
    } catch {
      await rm(clone, { recursive: true, force: true });
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Subpath "${subpath}" does not exist in the origin of pack "${slug}".`,
      );
    }
  }
}

function sanitizeTopic(topic: string): string {
  const cleaned = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "update";
}

function scaffoldIndex(input: { slug: string; title?: string; description?: string }): string {
  const title = input.title ?? input.slug;
  const description = input.description ?? "TODO: one-line description of this pack.";
  return `---
okf_version: "0.1"
type: Pack Index
title: ${title}
description: ${description}
---

# ${title}

> ${description}

## Goals

> ⚠️ UNVERIFIED: TODO — what is this pack for, and who reads it? (1-3 sentences.)

## Target questions

* TODO: the concrete questions a reader must be able to answer from this pack.

## Out of scope

* TODO: what this pack deliberately does not cover, and why.

## Concept types

* \`Pack Index\` — this scope-contract document.

## Concepts

_None yet._
`;
}
