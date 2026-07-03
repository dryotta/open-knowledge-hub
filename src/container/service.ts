import { mkdir, rm, stat, readdir } from "node:fs/promises";
import { resolve, relative, basename, join, isAbsolute } from "node:path";
import type { ZodType } from "zod";
import type { OkhPaths } from "../config.js";
import { containerCloneDir } from "../config.js";
import { OkhError, isOkhError } from "../errors.js";
import { Git } from "../git/git.js";
import { Gh } from "../git/gh.js";
import { Mutex } from "../util/mutex.js";
import {
  loadRegistry,
  saveRegistry,
  findContainer,
  requireContainer,
  withContainerAdded,
} from "../registry/registry.js";
import {
  containerNameSchema,
  repoUrlSchema,
  type Backend,
  type ContainerEntry,
} from "../registry/schema.js";
import {
  loadContainerManifest,
  saveContainerManifest,
  scaffoldManifest,
  manifestExists,
  modulePathSchema,
  type ContainerManifest,
  type ModuleEntry,
  type SyncMode,
} from "./manifest.js";
import { moduleTypeSchema, type ModuleType, type Item } from "../modules/types.js";
import { getLoader } from "../modules/registry.js";

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

function looksLikeGitUrl(s: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ||
    /^git@[^:]+:.+/.test(s) ||
    s.endsWith(".git")
  );
}

function deriveName(source: string): string {
  const base = basename(source.replace(/\.git$/, "").replace(/[\\/]+$/, ""));
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "container";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withPrCleanupFailure(
  primary: unknown,
  restore: unknown | undefined,
  checkout: unknown | undefined,
  base: string,
): unknown {
  const details = [
    restore ? `Failed to restore pending changes on base branch "${base}": ${errorMessage(restore)}` : undefined,
    checkout ? `Failed to return to base branch "${base}": ${errorMessage(checkout)}` : undefined,
  ].filter(Boolean);
  const cleanupMessage = `Also encountered cleanup failure: ${details.join("; ")}`;
  if (isOkhError(primary)) {
    return new OkhError(primary.code, `${primary.message}\n${cleanupMessage}`, primary.hint);
  }
  return new AggregateError(
    [primary, restore, checkout].filter((err) => err !== undefined),
    `${errorMessage(primary)}\n${cleanupMessage}`,
  );
}

function withOpenedPrCheckoutFailure(prUrl: string, checkout: unknown, base: string): OkhError {
  return new OkhError(
    "GIT_ERROR",
    `Opened PR ${prUrl}, but failed to return to base branch "${base}": ${errorMessage(checkout)}`,
    "The PR was created; manually check out the base branch before retrying.",
  );
}

export interface AddContainerInput {
  source: string;
  name?: string;
  sync?: "auto" | "pr";
  /** Only meaningful for path sources; distinguishes onedrive from plain local. */
  backend?: "local" | "onedrive";
}

export interface AddModuleInput {
  container: string;
  path: string;
  type: ModuleType;
  config?: Record<string, unknown>;
}

export interface GitStatus {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  hasUnpushedCommits: boolean;
}

export interface ModuleStatus {
  path: string;
  type: ModuleType;
  items: number;
}

export interface ContainerStatus {
  name: string;
  backend: Backend;
  sync?: SyncMode;
  localPath: string;
  manifestValid: boolean;
  manifestError?: string;
  modules: ModuleStatus[];
  git?: GitStatus;
}

export type InspectResult =
  | {
      kind: "containers";
      containers: Array<{
        name: string;
        backend: Backend;
        sync?: SyncMode;
        moduleCount: number;
        manifestValid: boolean;
        localPath: string;
      }>;
    }
  | { kind: "container"; status: ContainerStatus }
  | {
      kind: "module";
      module: { path: string; type: ModuleType; config?: Record<string, unknown> };
      items: Item[];
    };

export interface SyncResult {
  name: string;
  backend: Backend;
  validation: { ok: boolean; issues: string[] };
  action: "committed-pushed" | "pulled" | "up-to-date" | "pr-opened" | "validated" | "skipped" | "error";
  committed?: boolean;
  pushed?: boolean;
  prUrl?: string;
  error?: string;
}

export interface ResolvedModule {
  type: ModuleType;
  path: string;
  absPath: string;
}

export interface ResolvedContainer {
  name: string;
  backend: Backend;
  sync: SyncMode;
  root: string;
  modules: ResolvedModule[];
}

/**
 * High-level operations over the container registry. Combines the registry
 * (state), git (working trees), and gh (remote) layers. Registry read-modify-write
 * sequences are serialized by a Mutex.
 */
export class ContainerService {
  private readonly mutex = new Mutex();

  constructor(
    private readonly paths: OkhPaths,
    private readonly git: Git = new Git(),
    private readonly gh: Gh = new Gh(),
  ) {}

  async list(): Promise<ContainerEntry[]> {
    return (await loadRegistry(this.paths)).containers;
  }

  /** Enumerate a module's items, swallowing loader errors to an empty list. */
  private async safeEnumerate(type: ModuleType, moduleRoot: string): Promise<Item[]> {
    try {
      return await getLoader(type).enumerate(moduleRoot);
    } catch {
      return [];
    }
  }

  async status(name: string): Promise<ContainerStatus> {
    const reg = await loadRegistry(this.paths);
    const entry = requireContainer(reg, name);
    const root = entry.localPath;

    let manifest: ContainerManifest | undefined;
    let manifestValid = true;
    let manifestError: string | undefined;
    try {
      manifest = await loadContainerManifest(root);
    } catch (err) {
      manifestValid = false;
      manifestError = err instanceof OkhError ? err.message : String(err);
    }

    const modules: ModuleStatus[] = manifest
      ? await Promise.all(
          manifest.modules.map(async (m) => ({
            path: m.path,
            type: m.type,
            items: (await this.safeEnumerate(m.type, this.moduleRoot(root, m.path))).length,
          })),
        )
      : [];

    let git: GitStatus | undefined;
    if (entry.backend === "git") {
      const [branch, dirty, ab, unpushed] = await Promise.all([
        this.git.currentBranch(root),
        this.git.isDirty(root),
        this.git.aheadBehind(root),
        this.git.hasUnpushedCommits(root),
      ]);
      git = { branch, dirty, ahead: ab?.ahead ?? 0, behind: ab?.behind ?? 0, hasUnpushedCommits: unpushed };
    }

    return {
      name,
      backend: entry.backend,
      sync: manifest?.sync,
      localPath: root,
      manifestValid,
      manifestError,
      modules,
      git,
    };
  }

  /** Structural validation: manifest parses, module folders exist, knowledge has index.md. */
  async validate(name: string): Promise<{ ok: boolean; issues: string[] }> {
    const reg = await loadRegistry(this.paths);
    const entry = requireContainer(reg, name);
    const root = entry.localPath;
    let manifest: ContainerManifest;
    try {
      manifest = await loadContainerManifest(root);
    } catch (err) {
      return { ok: false, issues: [err instanceof OkhError ? err.message : String(err)] };
    }
    const issues: string[] = [];
    for (const m of manifest.modules) {
      const moduleRoot = this.moduleRoot(root, m.path);
      const s = await stat(moduleRoot).catch(() => null);
      if (!s || !s.isDirectory()) {
        issues.push(`module "${m.path}" (${m.type}): folder is missing`);
      }
      if (m.type === "knowledge") {
        const idx = await stat(join(moduleRoot, "index.md")).catch(() => null);
        if (!idx) issues.push(`knowledge module "${m.path}": missing index.md`);
      }
    }
    return { ok: issues.length === 0, issues };
  }

  async inspect(container?: string, module?: string): Promise<InspectResult> {
    const reg = await loadRegistry(this.paths);
    if (!container) {
      const containers = await Promise.all(
        reg.containers.map(async (c) => {
          const st = await this.status(c.name).catch(() => undefined);
          return {
            name: c.name,
            backend: c.backend,
            sync: st?.sync,
            moduleCount: st?.modules.length ?? 0,
            manifestValid: st?.manifestValid ?? false,
            localPath: c.localPath,
          };
        }),
      );
      return { kind: "containers", containers };
    }

    const entry = requireContainer(reg, container);
    if (!module) {
      return { kind: "container", status: await this.status(container) };
    }

    const manifest = await loadContainerManifest(entry.localPath);
    const mod = manifest.modules.find((m) => m.path === module);
    if (!mod) {
      throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
    }
    const items = await this.safeEnumerate(mod.type, this.moduleRoot(entry.localPath, mod.path));
    return {
      kind: "module",
      module: { path: mod.path, type: mod.type, ...(mod.config ? { config: mod.config } : {}) },
      items,
    };
  }

  /**
   * Resolve container/module filters to concrete paths for prompt context.
   * No filter => all containers. Skips containers whose manifest can't be read,
   * unless a specific container was requested (then it errors).
   */
  async resolveTargets(container?: string, module?: string): Promise<ResolvedContainer[]> {
    const reg = await loadRegistry(this.paths);
    const entries = container ? [requireContainer(reg, container)] : reg.containers;
    const out: ResolvedContainer[] = [];
    for (const entry of entries) {
      let manifest: ContainerManifest;
      try {
        manifest = await loadContainerManifest(entry.localPath);
      } catch (err) {
        if (container) {
          throw err instanceof OkhError
            ? err
            : new OkhError("INVALID_MANIFEST", `Container "${entry.name}" has an invalid manifest.`);
        }
        continue;
      }
      let modules = manifest.modules;
      if (module) modules = modules.filter((m) => m.path === module);
      if (container && module && modules.length === 0) {
        throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
      }
      out.push({
        name: entry.name,
        backend: entry.backend,
        sync: manifest.sync,
        root: entry.localPath,
        modules: modules.map((m) => ({
          type: m.type,
          path: m.path,
          absPath: this.moduleRoot(entry.localPath, m.path),
        })),
      });
    }
    return out;
  }

  sync(name?: string, message?: string): Promise<SyncResult[]> {
    return this.mutex.run(() => this.syncImpl(name, message));
  }

  private async syncImpl(name: string | undefined, message: string | undefined): Promise<SyncResult[]> {
    const reg = await loadRegistry(this.paths);
    if (name) return [await this.syncOne(requireContainer(reg, name), message)];

    const results: SyncResult[] = [];
    for (const entry of reg.containers) {
      try {
        results.push(await this.syncOne(entry, message));
      } catch (err) {
        if (!isOkhError(err)) throw err;
        results.push({
          name: entry.name,
          backend: entry.backend,
          validation: { ok: false, issues: [err.message] },
          action: "error",
          error: err.message,
        });
      }
    }
    return results;
  }

  private async syncOne(entry: ContainerEntry, message?: string): Promise<SyncResult> {
    const validation = await this.validate(entry.name);
    if (entry.backend !== "git") {
      return { name: entry.name, backend: entry.backend, validation, action: "validated" };
    }
    let manifest: ContainerManifest;
    try {
      manifest = await loadContainerManifest(entry.localPath);
    } catch {
      return { name: entry.name, backend: entry.backend, validation, action: "skipped" };
    }
    return manifest.sync === "pr"
      ? this.syncPr(entry, validation, message)
      : this.syncAuto(entry, validation, message);
  }

  private async syncAuto(
    entry: ContainerEntry,
    validation: { ok: boolean; issues: string[] },
    message?: string,
  ): Promise<SyncResult> {
    const root = entry.localPath;
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
        "The branch may have diverged from its upstream; resolve it manually.",
      );
    }
    const remote = await this.git.defaultRemote(root);
    const branch = await this.git.currentBranch(root);
    await this.git.push(root, remote, branch);
    return {
      name: entry.name,
      backend: entry.backend,
      validation,
      action: committed ? "committed-pushed" : "pulled",
      committed,
      pushed: true,
    };
  }

  private async syncPr(
    entry: ContainerEntry,
    validation: { ok: boolean; issues: string[] },
    message?: string,
  ): Promise<SyncResult> {
    const root = entry.localPath;
    const base = await this.git.currentBranch(root);
    if (base.startsWith(`okh/${entry.name}/sync-`)) {
      throw new OkhError(
        "GIT_ERROR",
        `Container "${entry.name}" is on generated sync branch "${base}". Check out the intended base branch before syncing.`,
      );
    }
    const dirty = await this.git.isDirty(root);
    const unpushed = await this.git.hasCurrentBranchUnpushedCommits(root);
    if (!dirty && !unpushed) {
      return { name: entry.name, backend: entry.backend, validation, action: "up-to-date" };
    }
    const branch = `okh/${entry.name}/sync-${Date.now()}`;
    let createdBranch = false;
    let operationError: unknown;
    let restoreError: unknown;
    let checkoutError: unknown;
    let result: SyncResult | undefined;
    try {
      await this.git.createBranch(root, branch);
      createdBranch = true;
      await this.git.stageAll(root);
      let committed = false;
      if (await this.git.hasStagedChanges(root)) {
        await this.git.commit(root, message ?? `okh: sync ${entry.name}`);
        committed = true;
      }
      const remote = await this.git.defaultRemote(root);
      await this.git.push(root, remote, branch);
      const prUrl = await this.gh.createPr({
        cwd: root,
        base,
        title: message ?? `okh sync: ${entry.name}`,
        body: "Automated OKH sync.",
      });
      result = { name: entry.name, backend: entry.backend, validation, action: "pr-opened", committed, pushed: true, prUrl };
    } catch (err) {
      operationError = err;
    }
    if (createdBranch) {
      if (operationError) {
        try {
          await this.git.resetSoft(root, base);
        } catch (err) {
          restoreError = err;
        }
      }
      try {
        await this.git.checkout(root, base);
      } catch (err) {
        checkoutError = err;
      }
    }
    if (operationError) {
      throw restoreError || checkoutError
        ? withPrCleanupFailure(operationError, restoreError, checkoutError, base)
        : operationError;
    }
    if (checkoutError) throw result?.prUrl ? withOpenedPrCheckoutFailure(result.prUrl, checkoutError, base) : checkoutError;
    return result!;
  }

  addContainer(input: AddContainerInput): Promise<ContainerEntry> {
    return this.mutex.run(() => this.addContainerImpl(input));
  }

  private async addContainerImpl(input: AddContainerInput): Promise<ContainerEntry> {
    const isGit = looksLikeGitUrl(input.source);
    const name = validate(containerNameSchema, input.name ?? deriveName(input.source), "name");
    const reg = await loadRegistry(this.paths);
    if (findContainer(reg, name)) {
      throw new OkhError("ALREADY_EXISTS", `A container named "${name}" already exists.`);
    }

    let backend: Backend;
    let localPath: string;
    let origin: string | undefined;

    if (isGit) {
      validate(repoUrlSchema, input.source, "source");
      backend = "git";
      origin = input.source;
      const clone = containerCloneDir(this.paths, name);
      await this.assertDirAvailable(clone);
      await mkdir(this.paths.containersDir, { recursive: true });
      try {
        await this.git.clone(input.source, clone);
      } catch (err) {
        await rm(clone, { recursive: true, force: true });
        throw err;
      }
      localPath = clone;
    } else {
      backend = input.backend ?? "local";
      const abs = resolve(input.source);
      const s = await stat(abs).catch(() => null);
      if (!s || !s.isDirectory()) {
        throw new OkhError("NOT_FOUND", `Path "${input.source}" is not an existing directory.`);
      }
      localPath = abs;
    }

    if (!(await manifestExists(localPath))) {
      await saveContainerManifest(localPath, {
        ...scaffoldManifest(name),
        sync: input.sync ?? "auto",
      });
    } else if (input.sync) {
      const m = await loadContainerManifest(localPath);
      await saveContainerManifest(localPath, { ...m, sync: input.sync });
    }

    const entry: ContainerEntry = {
      name,
      backend,
      ...(origin ? { origin } : {}),
      localPath,
      addedAt: new Date().toISOString(),
    };
    await saveRegistry(this.paths, withContainerAdded(reg, entry));
    return entry;
  }

  addModule(input: AddModuleInput): Promise<{ entry: ModuleEntry; moduleRoot: string }> {
    return this.mutex.run(() => this.addModuleImpl(input));
  }

  private async addModuleImpl(
    input: AddModuleInput,
  ): Promise<{ entry: ModuleEntry; moduleRoot: string }> {
    validate(modulePathSchema, input.path, "module path");
    validate(moduleTypeSchema, input.type, "module type");
    const reg = await loadRegistry(this.paths);
    const container = requireContainer(reg, input.container);
    const root = container.localPath;
    const manifest = await this.loadOrScaffold(root, container.name);
    if (manifest.modules.some((m) => m.path === input.path)) {
      throw new OkhError(
        "ALREADY_EXISTS",
        `Module path "${input.path}" already exists in container "${input.container}".`,
      );
    }
    const moduleRoot = this.moduleRoot(root, input.path);
    await mkdir(moduleRoot, { recursive: true });
    const loader = getLoader(input.type);
    if (loader.scaffold) {
      try {
        await loader.scaffold(moduleRoot);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    const entry: ModuleEntry = {
      path: input.path,
      type: input.type,
      ...(input.config ? { config: input.config } : {}),
    };
    await saveContainerManifest(root, { ...manifest, modules: [...manifest.modules, entry] });
    return { entry, moduleRoot };
  }

  /** Absolute path to a container's root on disk. */
  containerRoot(entry: ContainerEntry): string {
    return entry.localPath;
  }

  /** Absolute path to a module root, guarded against traversal outside the container. */
  protected moduleRoot(containerRoot: string, modulePath: string): string {
    const root = resolve(containerRoot, modulePath);
    const rel = relative(containerRoot, root);
    if (isAbsolute(rel) || rel.startsWith("..") || resolve(containerRoot, rel) !== root) {
      throw new OkhError("INVALID_ARGUMENT", `module path "${modulePath}" escapes the container.`);
    }
    return root;
  }

  protected async loadOrScaffold(root: string, name: string): Promise<ContainerManifest> {
    if (await manifestExists(root)) return loadContainerManifest(root);
    const m = scaffoldManifest(name);
    await saveContainerManifest(root, m);
    return m;
  }

  private async assertDirAvailable(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir);
      if (entries.length > 0) {
        throw new OkhError("ALREADY_EXISTS", `Target directory ${dir} already exists and is not empty.`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
