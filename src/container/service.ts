import { mkdir, rm, stat, readdir } from "node:fs/promises";
import { resolve, relative, basename, join, isAbsolute, normalize } from "node:path";
import { z } from "zod";
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
  withContainerUpdated,
} from "../registry/registry.js";
import {
  containerNameSchema,
  repoUrlSchema,
  type Backend,
  type ContainerEntry,
} from "../registry/schema.js";
import { discoverModules, type DiscoveredModule } from "../modules/discovery.js";
import { migrateLegacyContainerManifest } from "./migrate.js";
import { loadModuleManifest, saveModuleManifest, moduleManifestExists, type ModuleManifest } from "../modules/manifest.js";
import { type Item, type WikiHealth } from "../modules/types.js";
import { type SyncMode } from "../registry/schema.js";
import { getLoader } from "../modules/registry.js";
import { discoverModuleSkills, mergeSkills, type Skill } from "../modules/skills.js";
import { resolveSharedSkill as resolveShared } from "../modules/shared.js";
import { vendoredSkills } from "../modules/vendored.js";

const modulePathString = z
  .string().min(1)
  .refine((s) => !isAbsolute(s), "module path must be relative")
  .refine((s) => {
    const n = normalize(s).replace(/\\/g, "/");
    return n !== ".." && !n.startsWith("../") && !n.split("/").includes("..");
  }, "module path must not contain '..' segments")
  .refine((s) => {
    const first = normalize(s).replace(/\\/g, "/").split("/")[0];
    return first !== ".okh";
  }, "module path must not live inside .okh")
  .refine(
    (s) => normalize(s).replace(/\\/g, "/") !== ".",
    "module path must not be the container root",
  );

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
  /** Authorize side-effectful creation/initialization. Default false => preview only. */
  create?: boolean;
}

export type ContainerAction = "create-folder" | "clone";

export interface AddContainerPlan {
  kind: "container";
  actions: ContainerAction[];
  name: string;
  backend: Backend;
  source: string;
  /** Absolute local path to create / clone into / register. */
  target: string;
  /** Effective sync mode used when initializing a new manifest. */
  sync: SyncMode;
  /** Whether the caller explicitly set sync (controls overriding an existing manifest). */
  syncExplicit: boolean;
}

export type AddContainerOutcome =
  | { kind: "plan"; plan: AddContainerPlan }
  | { kind: "applied"; entry: ContainerEntry };

export type ModuleAction = "create-folder" | "scaffold";

export interface AddModulePlan {
  kind: "module";
  actions: ModuleAction[];
  container: string;
  path: string;
  type: string;
  name: string;
  description: string;
  moduleRoot: string;
  config?: Record<string, unknown>;
}

export type AddModuleOutcome =
  | { kind: "plan"; plan: AddModulePlan }
  | { kind: "applied"; entry: { path: string; type: string; name: string }; moduleRoot: string };

export interface AddModuleInput {
  container: string;
  path: string;
  type: string;
  name: string;
  description?: string;
  config?: Record<string, unknown>;
  create?: boolean;
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
  type: string;
  name: string;
  description: string;
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
        modules: Array<{ path: string; type: string; name: string }>;
        manifestValid: boolean;
        localPath: string;
      }>;
    }
  | { kind: "container"; status: ContainerStatus }
  | {
      kind: "module";
      module: { path: string; type: string; name: string; description: string; config?: Record<string, unknown> };
      overview: string;
      items: Item[];
      skills: Array<{ name: string; description: string }>;
      health?: WikiHealth;
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
  type: string;
  path: string;
  name: string;
  description: string;
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
  private async safeEnumerate(type: string, moduleRoot: string): Promise<Item[]> {
    try {
      return await getLoader(type).enumerate(moduleRoot);
    } catch {
      return [];
    }
  }

  /**
   * Migrate a legacy `.okh/okh.yaml` (if present) and persist its `sync` mode onto
   * the registry entry. The legacy manifest — deleted by migration — was the prior
   * source of truth for `sync`, so its value must not be lost to the schema default
   * ("auto"), which would silently drop a PR-only container to direct push. Idempotent:
   * a no-op once migrated. The registry write is mutex-guarded; callers under the
   * service mutex (sync's validate path) always pre-migrate first, so the guarded
   * write is never reached re-entrantly.
   */
  private async migrateAndPersistSync(name: string, root: string): Promise<void> {
    const migratedSync = await migrateLegacyContainerManifest(root).catch(() => undefined);
    if (migratedSync === undefined) return;
    await this.mutex.run(async () => {
      const reg = await loadRegistry(this.paths);
      if (!findContainer(reg, name)) return;
      await saveRegistry(this.paths, withContainerUpdated(reg, name, (e) => ({ ...e, sync: migratedSync })));
    });
  }

  async status(name: string): Promise<ContainerStatus> {
    const root = requireContainer(await loadRegistry(this.paths), name).localPath;
    await this.migrateAndPersistSync(name, root);
    const entry = requireContainer(await loadRegistry(this.paths), name);
    const discovered = await discoverModules(root);
    const invalid = discovered.filter((d) => d.error);
    const modules: ModuleStatus[] = await Promise.all(
      discovered
        .filter((d): d is DiscoveredModule & { manifest: ModuleManifest } => !!d.manifest)
        .map(async (d) => ({
          path: d.path,
          type: d.manifest.type,
          name: d.manifest.name,
          description: d.manifest.description,
          items: (await this.safeEnumerate(d.manifest.type, this.moduleRoot(root, d.path))).length,
        })),
    );

    let git: GitStatus | undefined;
    if (entry.backend === "git") {
      const [branch, dirty, ab, unpushed] = await Promise.all([
        this.git.currentBranch(root), this.git.isDirty(root),
        this.git.aheadBehind(root), this.git.hasUnpushedCommits(root),
      ]);
      git = { branch, dirty, ahead: ab?.ahead ?? 0, behind: ab?.behind ?? 0, hasUnpushedCommits: unpushed };
    }

    return {
      name, backend: entry.backend, sync: entry.sync, localPath: root,
      manifestValid: invalid.length === 0,
      ...(invalid.length ? { manifestError: invalid.map((d) => `${d.path}: ${d.error}`).join("; ") } : {}),
      modules, git,
    };
  }

  /** Structural validation: module manifests parse, knowledge has index.md. */
  async validate(name: string): Promise<{ ok: boolean; issues: string[] }> {
    const reg = await loadRegistry(this.paths);
    const entry = requireContainer(reg, name);
    const root = entry.localPath;
    await this.migrateAndPersistSync(name, root);
    const discovered = await discoverModules(root);
    const issues: string[] = [];
    for (const d of discovered) {
      if (d.error) { issues.push(`module "${d.path}": ${d.error}`); continue; }
      const m = d.manifest!;
      if (m.type === "knowledge") {
        const idx = await stat(join(this.moduleRoot(root, d.path), "index.md")).catch(() => null);
        if (!idx) issues.push(`knowledge module "${d.path}": missing index.md`);
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
            name: c.name, backend: c.backend, sync: st?.sync ?? c.sync,
            moduleCount: st?.modules.length ?? 0,
            modules: (st?.modules ?? []).map((m) => ({ path: m.path, type: m.type, name: m.name })),
            manifestValid: st?.manifestValid ?? false,
            localPath: c.localPath,
          };
        }),
      );
      return { kind: "containers", containers };
    }

    const entry = requireContainer(reg, container);
    if (!module) return { kind: "container", status: await this.status(container) };

    await this.migrateAndPersistSync(container, entry.localPath);
    const moduleRoot = this.moduleRoot(entry.localPath, module);
    if (!(await moduleManifestExists(moduleRoot))) {
      throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
    }
    const manifest = await loadModuleManifest(moduleRoot);
    const items = await this.safeEnumerate(manifest.type, moduleRoot);
    const skills = await this.effectiveSkills(container, module);
    const loader = getLoader(manifest.type);
    const overview = await loader.overview(moduleRoot).catch(() => "");
    const health = await loader.health?.(moduleRoot).catch(() => undefined);
    return {
      kind: "module",
      module: { path: module, type: manifest.type, name: manifest.name, description: manifest.description, ...(manifest.config ? { config: manifest.config } : {}) },
      overview,
      items,
      skills: skills.map(s => ({ name: s.name, description: s.description })),
      ...(health ? { health } : {}),
    };
  }

  /** The module's effective skill set: vendored (built-in type) ∪ module-local, local overriding by name. */
  async effectiveSkills(container: string, module: string): Promise<Skill[]> {
    const reg = await loadRegistry(this.paths);
    const entry = requireContainer(reg, container);
    const moduleRoot = this.moduleRoot(entry.localPath, module);
    if (!(await moduleManifestExists(moduleRoot))) {
      throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
    }
    const manifest = await loadModuleManifest(moduleRoot);
    const [vendored, local] = await Promise.all([
      vendoredSkills(manifest.type),
      discoverModuleSkills(moduleRoot),
    ]);
    return mergeSkills(vendored, local);
  }

  /** Resolve one named skill for a module; throws NOT_FOUND listing available skills. */
  async resolveSkill(container: string, module: string, skill: string): Promise<Skill> {
    const skills = await this.effectiveSkills(container, module);
    const found = skills.find((s) => s.name === skill);
    if (!found) {
      const names = skills.map((s) => s.name).join(", ") || "(none)";
      throw new OkhError("NOT_FOUND", `Module "${module}" has no skill "${skill}". Available: ${names}.`);
    }
    return found;
  }

  /** Resolve a module-less shared skill by name (runnable via run with no container/module). */
  resolveSharedSkill(name: string): Promise<Skill> {
    return resolveShared(name);
  }

  async resolveTargets(container?: string, module?: string): Promise<ResolvedContainer[]> {
    const reg0 = await loadRegistry(this.paths);
    const entries0 = container ? [requireContainer(reg0, container)] : reg0.containers;
    for (const e of entries0) await this.migrateAndPersistSync(e.name, e.localPath);
    const reg = await loadRegistry(this.paths);
    const entries = container ? [requireContainer(reg, container)] : reg.containers;
    const out: ResolvedContainer[] = [];
    for (const entry of entries) {
      let discovered = (await discoverModules(entry.localPath)).filter((d) => d.manifest);
      if (module) discovered = discovered.filter((d) => d.path === module);
      if (container && module && discovered.length === 0) {
        throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
      }
      out.push({
        name: entry.name, backend: entry.backend, sync: entry.sync, root: entry.localPath,
        modules: discovered.map((d) => ({
          type: d.manifest!.type, path: d.path, name: d.manifest!.name,
          description: d.manifest!.description, absPath: this.moduleRoot(entry.localPath, d.path),
        })),
      });
    }
    return out;
  }

  async sync(name?: string, message?: string): Promise<SyncResult[]> {
    const reg = await loadRegistry(this.paths);
    const entries = name ? reg.containers.filter((c) => c.name === name) : reg.containers;
    for (const e of entries) await this.migrateAndPersistSync(e.name, e.localPath);
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
        let validation: SyncResult["validation"];
        try {
          validation = await this.validate(entry.name);
        } catch {
          validation = { ok: false, issues: [] };
        }
        results.push({
          name: entry.name,
          backend: entry.backend,
          validation,
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
    return entry.sync === "pr"
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

  addContainer(input: AddContainerInput): Promise<AddContainerOutcome> {
    return this.mutex.run(() => this.addContainerImpl(input));
  }

  /** Resolve what `add` would do, with no side effects. Throws on doomed actions. */
  async planAddContainer(input: AddContainerInput): Promise<AddContainerPlan> {
    const isGit = looksLikeGitUrl(input.source);
    const name = validate(containerNameSchema, input.name ?? deriveName(input.source), "name");
    const reg = await loadRegistry(this.paths);
    if (findContainer(reg, name)) {
      throw new OkhError("ALREADY_EXISTS", `A container named "${name}" already exists.`);
    }
    const sync: SyncMode = input.sync ?? "auto";
    const syncExplicit = input.sync !== undefined;
    if (isGit) {
      validate(repoUrlSchema, input.source, "source");
      return {
        kind: "container",
        actions: ["clone"],
        name,
        backend: "git",
        source: input.source,
        target: containerCloneDir(this.paths, name),
        sync,
        syncExplicit,
      };
    }
    const backend: Backend = input.backend ?? "local";
    const target = resolve(input.source);
    const s = await stat(target).catch(() => null);
    if (s && !s.isDirectory()) {
      throw new OkhError("INVALID_ARGUMENT", `Path "${input.source}" exists but is not a directory.`);
    }
    const actions: ContainerAction[] = s ? [] : ["create-folder"];
    return { kind: "container", actions, name, backend, source: input.source, target, sync, syncExplicit };
  }

  private async addContainerImpl(input: AddContainerInput): Promise<AddContainerOutcome> {
    const plan = await this.planAddContainer(input);
    if (!input.create) return { kind: "plan", plan };
    return { kind: "applied", entry: await this.applyAddContainer(plan) };
  }

  private async applyAddContainer(plan: AddContainerPlan): Promise<ContainerEntry> {
    const reg = await loadRegistry(this.paths);
    if (findContainer(reg, plan.name)) {
      throw new OkhError("ALREADY_EXISTS", `A container named "${plan.name}" already exists.`);
    }
    let origin: string | undefined;
    if (plan.backend === "git") {
      origin = plan.source;
      await this.assertDirAvailable(plan.target);
      await mkdir(this.paths.containersDir, { recursive: true });
      try {
        await this.git.clone(plan.source, plan.target);
      } catch (err) {
        await rm(plan.target, { recursive: true, force: true });
        throw err;
      }
    } else {
      await mkdir(plan.target, { recursive: true });
    }
    const migratedSync = await migrateLegacyContainerManifest(plan.target).catch(() => undefined);
    const sync: SyncMode = plan.syncExplicit ? plan.sync : (migratedSync ?? plan.sync);
    const entry: ContainerEntry = {
      name: plan.name,
      backend: plan.backend,
      ...(origin ? { origin } : {}),
      localPath: plan.target,
      sync,
      addedAt: new Date().toISOString(),
    };
    await saveRegistry(this.paths, withContainerAdded(reg, entry));
    return entry;
  }

  addModule(input: AddModuleInput): Promise<AddModuleOutcome> {
    return this.mutex.run(() => this.addModuleImpl(input));
  }

  async planAddModule(input: AddModuleInput): Promise<AddModulePlan> {
    validate(modulePathString, input.path, "module path");
    const reg = await loadRegistry(this.paths);
    const container = requireContainer(reg, input.container);
    const root = container.localPath;
    const moduleRoot = this.moduleRoot(root, input.path);
    if (await moduleManifestExists(moduleRoot)) {
      throw new OkhError(
        "ALREADY_EXISTS",
        `Module path "${input.path}" already exists in container "${input.container}".`,
      );
    }
    const actions: ModuleAction[] = [];
    const modDir = await stat(moduleRoot).then((x) => x.isDirectory()).catch(() => false);
    if (!modDir) actions.push("create-folder");
    if (getLoader(input.type).scaffold) actions.push("scaffold");
    return {
      kind: "module",
      actions,
      container: input.container,
      path: input.path,
      type: input.type,
      name: input.name,
      description: input.description ?? "",
      moduleRoot,
      ...(input.config ? { config: input.config } : {}),
    };
  }

  private async addModuleImpl(input: AddModuleInput): Promise<AddModuleOutcome> {
    const plan = await this.planAddModule(input);
    if (!input.create) return { kind: "plan", plan };
    return { kind: "applied", ...(await this.applyAddModule(plan)) };
  }

  private async applyAddModule(plan: AddModulePlan): Promise<{ entry: { path: string; type: string; name: string }; moduleRoot: string }> {
    await mkdir(plan.moduleRoot, { recursive: true });
    const loader = getLoader(plan.type);
    if (loader.scaffold) {
      try {
        await loader.scaffold(plan.moduleRoot);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    await saveModuleManifest(plan.moduleRoot, {
      type: plan.type, name: plan.name, description: plan.description,
      ...(plan.config ? { config: plan.config } : {}),
    });
    return { entry: { path: plan.path, type: plan.type, name: plan.name }, moduleRoot: plan.moduleRoot };
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
