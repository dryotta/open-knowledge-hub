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
  type BackendType,
  type SyncMode,
  type ContainerEntry,
  type BackendDescriptor,
  type SyncDescriptor,
} from "../registry/schema.js";
import { discoverModules, type DiscoveredModule } from "../modules/discovery.js";
import { migrateLegacyContainerManifest, removeLegacyContainerManifest } from "./migrate.js";
import { loadModuleManifest, saveModuleManifest, moduleManifestExists, type ModuleManifest } from "../modules/manifest.js";
import { type Item, type WikiHealth } from "../modules/types.js";
import { getLoader } from "../modules/registry.js";
import {
  discoverModuleSkillSet,
  mergeSkills,
  skillRootsForType,
  validateModuleSkills,
  type Skill,
} from "../modules/skills.js";
import { resolveSharedSkill as resolveShared, sharedSkills } from "../modules/shared.js";
import { vendoredSkills } from "../modules/vendored.js";
import { loadPreferences } from "../preferences.js";
import { BackendRegistry, createBackendRegistry } from "../sync/backendRegistry.js";
import type { BackendSyncResult, SyncSelection } from "../sync/types.js";

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
  )
  .refine(
    (s) => !normalize(s).replace(/\\/g, "/").includes("/"),
    "module path must be a single top-level folder name (modules cannot be nested)",
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

export interface AddContainerInput {
  source: string;
  name?: string;
  /** Sync descriptor for the container: `{ mode, config? }`. */
  sync?: { mode: SyncMode; config?: Record<string, unknown> };
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
  /** Structured backend descriptor: type + config. */
  backend: BackendDescriptor;
  source: string;
  /** Absolute local path to create / clone into / register. */
  target: string;
  /** Fully resolved sync descriptor (mode + config). */
  sync: SyncDescriptor;
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
  description: string;
  moduleRoot: string;
  config?: Record<string, unknown>;
}

export type AddModuleOutcome =
  | { kind: "plan"; plan: AddModulePlan }
  | { kind: "applied"; entry: { path: string; type: string }; moduleRoot: string };

export interface AddModuleInput {
  container: string;
  path: string;
  type: string;
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
  description: string;
  items: number;
}

export interface ContainerStatus {
  name: string;
  backend: BackendType;
  sync?: SyncDescriptor;
  syncActions?: string[];
  localPath: string;
  manifestValid: boolean;
  manifestError?: string;
  modules: ModuleStatus[];
  git?: GitStatus;
}

/** A skill reference in the hub map: just enough to list and route to it. */
export interface SkillRef {
  name: string;
  description: string;
}

/** One module in the hub map. Module type skills are hoisted to `HubMap.moduleTypeSkills`
 * (keyed by `type`) so they are never repeated here; only in-repo `local` skills live on
 * the module. `overrides` are local skill names that shadow a same-named module type skill.
 * Full per-skill provenance (source path) is available via the module drilldown. */
export interface HubModule {
  path: string;
  type: string;
  description: string;
  items: number;
  local?: SkillRef[];
  overrides?: string[];
}

/** One container in the hub map. */
export interface HubContainer {
  name: string;
  backend: BackendType;
  sync?: SyncDescriptor;
  syncActions?: string[];
  localPath: string;
  manifestValid: boolean;
  manifestError?: string;
  modules: HubModule[];
}

/** The full hub map returned by no-arg `inspect`: every container, module, and runnable
 * skill, factored by provenance. Global skills are listed once; module type skills once
 * per in-use type; only local skills are carried per module. */
export interface HubMap {
  kind: "hub";
  wakePhrase: string;
  /** Server-bundled skills, run module-less via `run { skill }`. */
  globalSkills: SkillRef[];
  /** Skills provided by a module's type, keyed by type. Only in-use types with skills appear. */
  moduleTypeSkills: Record<string, SkillRef[]>;
  containers: HubContainer[];
}

export type InspectResult =
  | HubMap
  | { kind: "container"; status: ContainerStatus }
  | {
      kind: "module";
      module: { path: string; type: string; description: string; config?: Record<string, unknown> };
      overview: string;
      items: Item[];
      skills: Array<{ name: string; description: string; source: string; path?: string }>;
      skillIssues?: string[];
      health?: WikiHealth;
    };

/** SyncResult extends BackendSyncResult with service-level envelope fields. */
export interface SyncResult extends BackendSyncResult {
  name: string;
  backend: BackendType;
  validation: { ok: boolean; issues: string[] };
  error?: string;
}

export interface ResolvedModule {
  type: string;
  path: string;
  description: string;
  absPath: string;
}

export interface ResolvedContainer {
  name: string;
  backend: BackendType;
  sync: SyncDescriptor;
  syncActions: string[];
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
  private readonly migrationMutex = new Mutex();
  private readonly backends: BackendRegistry;
  private readonly gh: Gh;

  constructor(
    private readonly paths: OkhPaths,
    private readonly git: Git = new Git(),
    gh: Gh = new Gh(),
    backends?: BackendRegistry,
  ) {
    this.gh = gh;
    this.backends = backends ?? createBackendRegistry(git, gh);
  }

  /**
   * Load the registry, automatically migrating v1 → v2 using the gh login when
   * needed. Passes `resolveGitLogin` so legacy git+pr entries are resolved to
   * `shared` with the correct branch during registry-level migration.
   */
  private loadRegistryData() {
    return loadRegistry(this.paths, { resolveGitLogin: () => this.gh.currentLogin() });
  }

  async list(): Promise<ContainerEntry[]> {
    return (await this.loadRegistryData()).containers;
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
   * the registry entry. Calls `removeLegacyContainerManifest` only after the registry
   * save succeeds. On resolution/save failure, preserves both the legacy file and the
   * old registry entry. Does NOT acquire the mutex (avoids reentrancy when called
   * from paths already inside the outer mutex).
   */
  private async migrateAndPersistSync(name: string, root: string): Promise<void> {
    return this.migrationMutex.run(async () => {
      const legacyMode = await migrateLegacyContainerManifest(root).catch(() => undefined);
      if (legacyMode === undefined) return;

      const reg = await this.loadRegistryData();
      const entry = findContainer(reg, name);
      if (!entry) return;

      let mode: SyncMode;
      let syncConfig: Record<string, unknown> = {};

      if (entry.backend.type === "git" && legacyMode === "pr") {
        mode = "shared";
        try {
          const resolved = await this.backends.resolveSync(
            "git",
            { mode: "shared", config: {} },
            { containerName: name },
          );
          syncConfig = resolved.config;
        } catch {
          // Cannot resolve (e.g. gh login unavailable) — preserve legacy file and old entry.
          return;
        }
      } else {
        mode = "auto";
      }

      try {
        await saveRegistry(
          this.paths,
          withContainerUpdated(reg, name, (e) => ({ ...e, sync: { mode, config: syncConfig } })),
        );
        await removeLegacyContainerManifest(root);
      } catch {
        // On save failure, preserve legacy file and old registry entry.
      }
    });
  }

  async status(name: string): Promise<ContainerStatus> {
    const root = requireContainer(await this.loadRegistryData(), name).localPath;
    await this.migrateAndPersistSync(name, root);
    const entry = requireContainer(await this.loadRegistryData(), name);
    const discovered = await discoverModules(root);
    const invalid = discovered.filter((d) => d.error);
    const modules: ModuleStatus[] = await Promise.all(
      discovered
        .filter((d): d is DiscoveredModule & { manifest: ModuleManifest } => !!d.manifest)
        .map(async (d) => ({
          path: d.path,
          type: d.manifest.type,
          description: d.manifest.description,
          items: (await this.safeEnumerate(d.manifest.type, this.moduleRoot(root, d.path))).length,
        })),
    );

    let git: GitStatus | undefined;
    if (entry.backend.type === "git") {
      const [branch, dirty, ab, unpushed] = await Promise.all([
        this.git.currentBranch(root), this.git.isDirty(root),
        this.git.aheadBehind(root), this.git.hasUnpushedCommits(root),
      ]);
      git = { branch, dirty, ahead: ab?.ahead ?? 0, behind: ab?.behind ?? 0, hasUnpushedCommits: unpushed };
    }

    const syncActions = this.backends.actions(entry);

    return {
      name, backend: entry.backend.type, sync: entry.sync, syncActions: [...syncActions], localPath: root,
      manifestValid: invalid.length === 0,
      ...(invalid.length ? { manifestError: invalid.map((d) => `${d.path}: ${d.error}`).join("; ") } : {}),
      modules, git,
    };
  }

  /** Structural validation: manifests, type-required files, and local skill trees. */
  async validate(name: string): Promise<{ ok: boolean; issues: string[] }> {
    const reg = await this.loadRegistryData();
    const entry = requireContainer(reg, name);
    const root = entry.localPath;
    await this.migrateAndPersistSync(name, root);
    const discovered = await discoverModules(root);
    const issues: string[] = [];
    for (const d of discovered) {
      if (d.error) { issues.push(`module "${d.path}": ${d.error}`); continue; }
      const m = d.manifest!;
      const moduleRoot = this.moduleRoot(root, d.path);
      if (m.description.trim().length === 0) {
        issues.push(`module "${d.path}": missing description (run dream to consolidate one).`);
      }
      const loader = getLoader(m.type);
      for (const requiredFile of loader.requiredFiles ?? []) {
        const file = await stat(join(moduleRoot, requiredFile)).catch(() => null);
        if (!file?.isFile()) {
          issues.push(`${m.type} module "${d.path}": missing ${requiredFile}`);
        }
      }
      for (const issue of await validateModuleSkills(moduleRoot, skillRootsForType(m.type))) {
        issues.push(`module "${d.path}" skill tree: ${issue}`);
      }
    }
    return { ok: issues.length === 0, issues };
  }

  async inspect(container?: string, module?: string): Promise<InspectResult> {
    const reg = await this.loadRegistryData();
    if (!container) return this.buildHubMap(reg);

    const entry = requireContainer(reg, container);
    if (!module) return { kind: "container", status: await this.status(container) };

    await this.migrateAndPersistSync(container, entry.localPath);
    const moduleRoot = this.moduleRoot(entry.localPath, module);
    if (!(await moduleManifestExists(moduleRoot))) {
      throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
    }
    const manifest = await loadModuleManifest(moduleRoot);
    const items = await this.safeEnumerate(manifest.type, moduleRoot);
    const skillSet = await this.collectEffectiveSkills(manifest.type, moduleRoot);
    const loader = getLoader(manifest.type);
    const overview = await loader.overview(moduleRoot).catch(() => "");
    const health = await loader.health?.(moduleRoot).catch(() => undefined);
    return {
      kind: "module",
      module: { path: module, type: manifest.type, description: manifest.description, ...(manifest.config ? { config: manifest.config } : {}) },
      overview,
      items,
      skills: skillSet.skills.map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
        ...(s.path ? { path: s.path } : {}),
      })),
      ...(skillSet.issues.length ? { skillIssues: skillSet.issues } : {}),
      ...(health ? { health } : {}),
    };
  }

  private async collectEffectiveSkills(
    type: string,
    moduleRoot: string,
  ): Promise<{ skills: Skill[]; issues: string[] }> {
    const [vendored, local] = await Promise.all([
      vendoredSkills(type),
      discoverModuleSkillSet(moduleRoot, skillRootsForType(type)),
    ]);
    return { skills: mergeSkills(vendored, local.skills), issues: local.issues };
  }

  /** Build the full hub map: containers → modules, with skills factored by provenance
   * (global once, module type once per in-use type, local per module). */
  private async buildHubMap(reg: { containers: ContainerEntry[] }): Promise<HubMap> {
    const wakePhrase = (await loadPreferences(this.paths)).wakePhrase;
    const containers: HubContainer[] = [];
    const typesInUse = new Set<string>();
    for (const c of reg.containers) {
      const st = await this.status(c.name).catch(() => undefined);
      const mods = st?.modules ?? [];
      for (const m of mods) typesInUse.add(m.type);
      const modules = await Promise.all(mods.map((m) => this.buildHubModule(c.localPath, m)));
      containers.push({
        name: c.name,
        backend: c.backend.type,
        sync: st?.sync ?? c.sync,
        syncActions: st?.syncActions ?? [...this.backends.actions(c)],
        localPath: c.localPath,
        manifestValid: st?.manifestValid ?? false,
        ...(st?.manifestError ? { manifestError: st.manifestError } : {}),
        modules,
      });
    }

    const moduleTypeSkills: Record<string, SkillRef[]> = {};
    for (const type of [...typesInUse].sort()) {
      const skills = await vendoredSkills(type);
      if (skills.length) {
        moduleTypeSkills[type] = skills.map((s) => ({ name: s.name, description: s.description }));
      }
    }

    const globalSkills = (await sharedSkills()).map((s) => ({ name: s.name, description: s.description }));
    return { kind: "hub", wakePhrase, globalSkills, moduleTypeSkills, containers };
  }

  /** Build one hub-map module entry: carries only its in-repo `local` skills (module type
   * skills are hoisted) and records `overrides` where a local name shadows a module type skill. */
  private async buildHubModule(containerRoot: string, m: ModuleStatus): Promise<HubModule> {
    const moduleRoot = this.moduleRoot(containerRoot, m.path);
    const [localSet, vendored] = await Promise.all([
      discoverModuleSkillSet(moduleRoot, skillRootsForType(m.type)),
      vendoredSkills(m.type),
    ]);
    const vendoredNames = new Set(vendored.map((s) => s.name));
    const local: SkillRef[] = localSet.skills.map((s) => ({ name: s.name, description: s.description }));
    const overrides = local.filter((s) => vendoredNames.has(s.name)).map((s) => s.name);
    return {
      path: m.path,
      type: m.type,
      description: m.description,
      items: m.items,
      ...(local.length ? { local } : {}),
      ...(overrides.length ? { overrides } : {}),
    };
  }

  private async effectiveSkillSet(
    container: string,
    module: string,
  ): Promise<{ skills: Skill[]; issues: string[] }> {
    const reg = await this.loadRegistryData();
    const entry = requireContainer(reg, container);
    const moduleRoot = this.moduleRoot(entry.localPath, module);
    if (!(await moduleManifestExists(moduleRoot))) {
      throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
    }
    const manifest = await loadModuleManifest(moduleRoot);
    return this.collectEffectiveSkills(manifest.type, moduleRoot);
  }

  /** The module's effective skill set: vendored (built-in type) ∪ module-local, local overriding by name. */
  async effectiveSkills(container: string, module: string): Promise<Skill[]> {
    return (await this.effectiveSkillSet(container, module)).skills;
  }

  /** Resolve one named skill for a module; throws NOT_FOUND listing available skills. */
  async resolveSkill(container: string, module: string, skill: string): Promise<Skill> {
    const skillSet = await this.effectiveSkillSet(container, module);
    const matches = skillSet.skills.filter((candidate) => candidate.name === skill);
    if (matches.length > 1) {
      const locations = matches
        .map((match) => `${match.source}:${match.path ?? match.name}`)
        .join(", ");
      throw new OkhError(
        "CONFLICT",
        `Module "${module}" has multiple skills named "${skill}": ${locations}. Rename them to be unique within the module.`,
      );
    }
    if (matches.length === 0) {
      const names = [...new Set(skillSet.skills.map((candidate) => candidate.name))].join(", ") || "(none)";
      const issues = skillSet.issues.length
        ? ` Structural issues: ${skillSet.issues.join("; ")}.`
        : "";
      throw new OkhError(
        "NOT_FOUND",
        `Module "${module}" has no skill "${skill}". Available: ${names}.${issues}`,
      );
    }
    return matches[0]!;
  }

  /** Resolve a module-less shared skill by name (runnable via run with no container/module). */
  resolveSharedSkill(name: string): Promise<Skill> {
    return resolveShared(name);
  }

  async resolveTargets(container?: string, module?: string): Promise<ResolvedContainer[]> {
    const reg0 = await this.loadRegistryData();
    const entries0 = container ? [requireContainer(reg0, container)] : reg0.containers;
    for (const e of entries0) await this.migrateAndPersistSync(e.name, e.localPath);
    const reg = await this.loadRegistryData();
    const entries = container ? [requireContainer(reg, container)] : reg.containers;
    const out: ResolvedContainer[] = [];
    for (const entry of entries) {
      let discovered = (await discoverModules(entry.localPath)).filter((d) => d.manifest);
      if (module) discovered = discovered.filter((d) => d.path === module);
      if (container && module && discovered.length === 0) {
        throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
      }
      out.push({
        name: entry.name, backend: entry.backend.type, sync: entry.sync,
        syncActions: [...this.backends.actions(entry)],
        root: entry.localPath,
        modules: discovered.map((d) => ({
          type: d.manifest!.type, path: d.path,
          description: d.manifest!.description, absPath: this.moduleRoot(entry.localPath, d.path),
        })),
      });
    }
    return out;
  }

  async sync(name?: string, message?: string, action?: string): Promise<SyncResult[]> {
    if (action !== undefined && name === undefined) {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `An action ("${action}") requires a named container. Specify a container name.`,
      );
    }
    const reg = await this.loadRegistryData();
    const entries = name ? reg.containers.filter((c) => c.name === name) : reg.containers;
    for (const e of entries) await this.migrateAndPersistSync(e.name, e.localPath);
    return this.mutex.run(() => this.syncImpl(name, message, action));
  }

  private async syncImpl(name: string | undefined, message: string | undefined, action: string | undefined): Promise<SyncResult[]> {
    const reg = await this.loadRegistryData();
    if (name) return [await this.syncOne(requireContainer(reg, name), message, action)];

    const results: SyncResult[] = [];
    for (const entry of reg.containers) {
      try {
        results.push(await this.syncOne(entry, message, undefined));
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
          backend: entry.backend.type,
          validation,
          mode: entry.sync.mode,
          outcome: "error",
          error: err.message,
        });
      }
    }
    return results;
  }

  private async syncOne(entry: ContainerEntry, message?: string, action?: string): Promise<SyncResult> {
    const validation = await this.validate(entry.name);
    const backend = this.backends.require(entry.backend.type);
    const backendResult = await backend.sync({
      entry,
      validation,
      ...(message !== undefined ? { message } : {}),
      ...(action !== undefined ? { action } : {}),
    });
    return { name: entry.name, backend: entry.backend.type, validation, ...backendResult };
  }

  addContainer(input: AddContainerInput): Promise<AddContainerOutcome> {
    return this.mutex.run(() => this.addContainerImpl(input));
  }

  /** Normalize the sync input field to a SyncSelection. */
  private normalizeSyncInput(sync: AddContainerInput["sync"]): SyncSelection {
    if (sync === undefined) {
      return { mode: "auto", config: {} };
    }
    return { mode: sync.mode, config: sync.config ?? {} };
  }

  /** Resolve what `add` would do, with no side effects. Throws on doomed actions. */
  async planAddContainer(input: AddContainerInput): Promise<AddContainerPlan> {
    const isGit = looksLikeGitUrl(input.source);
    const name = validate(containerNameSchema, input.name ?? deriveName(input.source), "name");
    const reg = await this.loadRegistryData();
    if (findContainer(reg, name)) {
      throw new OkhError("ALREADY_EXISTS", `A container named "${name}" already exists.`);
    }
    const syncExplicit = input.sync !== undefined;
    if (isGit) {
      validate(repoUrlSchema, input.source, "source");
      const backendConfig = this.backends.resolveBackendConfig("git", { origin: input.source });
      const syncSelection = this.normalizeSyncInput(input.sync);
      const resolvedSync = await this.backends.resolveSync("git", syncSelection, { containerName: name });
      return {
        kind: "container",
        actions: ["clone"],
        name,
        backend: { type: "git", config: backendConfig },
        source: input.source,
        target: containerCloneDir(this.paths, name),
        sync: resolvedSync,
        syncExplicit,
      };
    }
    const backendType: BackendType = input.backend ?? "local";
    const syncSelection = this.normalizeSyncInput(input.sync);
    const backendConfig = this.backends.resolveBackendConfig(backendType, {});
    const resolvedSync = await this.backends.resolveSync(backendType, syncSelection, { containerName: name });
    const target = resolve(input.source);
    const s = await stat(target).catch(() => null);
    if (s && !s.isDirectory()) {
      throw new OkhError("INVALID_ARGUMENT", `Path "${input.source}" exists but is not a directory.`);
    }
    const actions: ContainerAction[] = s ? [] : ["create-folder"];
    return {
      kind: "container", actions, name,
      backend: { type: backendType, config: backendConfig },
      source: input.source, target,
      sync: resolvedSync,
      syncExplicit,
    };
  }

  private async addContainerImpl(input: AddContainerInput): Promise<AddContainerOutcome> {
    const plan = await this.planAddContainer(input);
    if (!input.create) return { kind: "plan", plan };
    return { kind: "applied", entry: await this.applyAddContainer(plan) };
  }

  private async applyAddContainer(plan: AddContainerPlan): Promise<ContainerEntry> {
    const reg = await this.loadRegistryData();
    if (findContainer(reg, plan.name)) {
      throw new OkhError("ALREADY_EXISTS", `A container named "${plan.name}" already exists.`);
    }
    if (plan.backend.type === "git") {
      await this.assertDirAvailable(plan.target);
      await mkdir(this.paths.containersDir, { recursive: true });
      try {
        await this.git.clone(plan.backend.config["origin"] as string, plan.target);
      } catch (err) {
        await rm(plan.target, { recursive: true, force: true });
        throw err;
      }
    } else {
      await mkdir(plan.target, { recursive: true });
    }
    const legacyMode = await migrateLegacyContainerManifest(plan.target).catch(() => undefined);
    let effectiveSync: SyncDescriptor;
    if (plan.syncExplicit || legacyMode === undefined) {
      effectiveSync = plan.sync;
    } else if (plan.backend.type === "git" && legacyMode === "pr") {
      // Legacy "pr" from cloned repo: resolve shared branch via adapter.
      try {
        effectiveSync = await this.backends.resolveSync(
          "git",
          { mode: "shared", config: {} },
          { containerName: plan.name },
        );
      } catch {
        effectiveSync = plan.sync;
      }
    } else {
      effectiveSync = { mode: "auto", config: {} };
    }
    const entry: ContainerEntry = {
      name: plan.name,
      backend: plan.backend,
      localPath: plan.target,
      sync: effectiveSync,
      addedAt: new Date().toISOString(),
    };
    await saveRegistry(this.paths, withContainerAdded(reg, entry));
    // Remove legacy manifest only after the registry save succeeded.
    if (legacyMode !== undefined) {
      await removeLegacyContainerManifest(plan.target).catch(() => undefined);
    }
    return entry;
  }

  addModule(input: AddModuleInput): Promise<AddModuleOutcome> {
    return this.mutex.run(() => this.addModuleImpl(input));
  }

  /** Read a module's manifest (type, description, and arbitrary config map). */
  async getModuleManifest(container: string, module: string): Promise<ModuleManifest> {
    const reg = await this.loadRegistryData();
    const entry = requireContainer(reg, container);
    const moduleRoot = this.moduleRoot(entry.localPath, module);
    if (!(await moduleManifestExists(moduleRoot))) {
      throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
    }
    return loadModuleManifest(moduleRoot);
  }

  /**
   * Apply a key/value patch to a module's manifest. `description` maps to the
   * top-level field (validated non-blank); `type` is rejected (it selects the
   * loader); every other key is written into the manifest's arbitrary `config`
   * map. A `null` value deletes an arbitrary config key. Returns the saved
   * manifest. Legacy fields (e.g. `name`) are dropped as a side effect of the
   * rewrite through the schema.
   */
  setModuleConfig(container: string, module: string, patch: Record<string, unknown>): Promise<ModuleManifest> {
    return this.mutex.run(async () => {
      if (Object.keys(patch).length === 0) {
        throw new OkhError("INVALID_ARGUMENT", "config { set } must include at least one key.");
      }
      const reg = await this.loadRegistryData();
      const entry = requireContainer(reg, container);
      const moduleRoot = this.moduleRoot(entry.localPath, module);
      if (!(await moduleManifestExists(moduleRoot))) {
        throw new OkhError("NOT_FOUND", `Container "${container}" has no module "${module}".`);
      }
      const manifest = await loadModuleManifest(moduleRoot);
      const cfg: Record<string, unknown> = { ...(manifest.config ?? {}) };
      let description = manifest.description;
      for (const [key, value] of Object.entries(patch)) {
        if (key === "type") {
          throw new OkhError(
            "INVALID_ARGUMENT",
            "A module's type cannot be changed via config (it selects the loader). Recreate the module to change its type.",
          );
        }
        if (key === "description") {
          if (value === null) {
            throw new OkhError("INVALID_ARGUMENT", "Module description is required and cannot be deleted.");
          }
          if (typeof value !== "string" || value.trim().length === 0) {
            throw new OkhError("INVALID_ARGUMENT", "Module description must be a non-empty string.");
          }
          description = value.trim();
          continue;
        }
        if (value === null) delete cfg[key];
        else cfg[key] = value;
      }
      const next: ModuleManifest = { ...manifest, description };
      if (Object.keys(cfg).length > 0) next.config = cfg;
      else delete next.config;
      await saveModuleManifest(moduleRoot, next);
      return next;
    });
  }

  async planAddModule(input: AddModuleInput): Promise<AddModulePlan> {
    validate(modulePathString, input.path, "module path");
    const reg = await this.loadRegistryData();
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

  private async applyAddModule(plan: AddModulePlan): Promise<{ entry: { path: string; type: string }; moduleRoot: string }> {
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
      type: plan.type, description: plan.description,
      ...(plan.config ? { config: plan.config } : {}),
    });
    return { entry: { path: plan.path, type: plan.type }, moduleRoot: plan.moduleRoot };
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
