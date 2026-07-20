import { mkdir, mkdtemp, cp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { run } from "../src/exec.js";
import { Git } from "../src/git/git.js";
import { emptyRegistry, type ContainerEntry } from "../src/registry/schema.js";
import { saveRegistry, withContainerAdded } from "../src/registry/registry.js";
import type { OkhPaths } from "../src/config.js";
import { seedWorkspaceEnvironment } from "./workspaceEnvironment.js";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

export type EvalBackend = "local" | "git-auto";

/** One hub within an environment. `fixture` is relative to eval/ (or absolute). */
export interface EnvHub {
  container: string;
  fixture: string;
  backend?: EvalBackend; // default "local"
}

/**
 * An eval environment. `placement: "registered"` copies each hub into the OKH
 * registry (seeding a bare git origin for git-auto hubs); `placement: "workspace"`
 * drops each hub as an UNREGISTERED folder in the working dir (registry stays empty).
 * hubs[0] is the primary hub (drives containerPath/fixtureDir/originPath).
 */
export interface Environment {
  placement: "registered" | "workspace";
  hubs: EnvHub[];
  workspaceDir?: string;
  seed?: "workspace";
}

export const environments = {
  empty: {
    placement: "workspace",
    hubs: [{ container: "notes", fixture: "fixtures/plain-notes" }],
    workspaceDir: undefined,
  },
  git: {
    placement: "registered",
    hubs: [{ container: "git-hub", fixture: "fixtures/git-hub", backend: "git-auto" }],
    workspaceDir: undefined,
  },
  "local-and-git": {
    placement: "registered",
    hubs: [
      { container: "kb-hub", fixture: "fixtures/kb-hub", backend: "local" },
      { container: "git-hub", fixture: "fixtures/git-hub", backend: "git-auto" },
    ],
    workspaceDir: undefined,
  },
  custom: {
    placement: "registered",
    hubs: [{ container: "custom-hub", fixture: "fixtures/custom-hub", backend: "local" }],
    workspaceDir: undefined,
  },
  health: {
    placement: "registered",
    hubs: [{ container: "health-hub", fixture: "fixtures/health-hub", backend: "local" }],
    workspaceDir: "fixtures/health-source",
  },
  wiki: {
    placement: "registered",
    hubs: [{ container: "wiki-hub", fixture: "fixtures/wiki-hub", backend: "local" }],
    workspaceDir: undefined,
  },
  workspace: {
    placement: "registered",
    hubs: [
      {
        container: "work-hub",
        fixture: "fixtures/workspace-work-hub",
        backend: "git-auto",
      },
      {
        container: "personal-hub",
        fixture: "fixtures/workspace-personal-hub",
        backend: "local",
      },
    ],
    workspaceDir: undefined,
    seed: "workspace",
  },
} satisfies Record<string, Environment>;

export type EnvName = keyof typeof environments;

export function isEnvName(v: unknown): v is EnvName {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(environments, v);
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validateRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`invalid eval run id: ${JSON.stringify(runId)}`);
  }
}

/** Prefix an environment label with the current automated run id for scoped cleanup. */
export function evalEnvironmentLabel(env: EnvName, runId = process.env.OKH_EVAL_RUN_ID): string {
  if (!runId) return env;
  validateRunId(runId);
  return `${runId}-${env}`;
}

/** Remove only temp roots created by one automated eval run. */
export async function cleanupEvalEnvironments(
  runId: string,
  tempRoot = tmpdir(),
  remove: RemoveTempRoot = (root) => rm(root, { recursive: true, force: true }),
): Promise<string[]> {
  validateRunId(runId);
  const prefix = `okh-eval-${runId}-`;
  const roots = (await readdir(tempRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => join(tempRoot, entry.name));
  await Promise.all(roots.map((root) => remove(root)));
  return roots;
}

export interface Provisioned {
  root: string;
  okhHome: string;
  copilotHome: string;
  workspace: string;
  /** Primary hub's local path (workspace/<name> for a workspace-placed hub). */
  containerPath: string;
  /** Primary hub's resolved fixture dir (used by okf-valid requireChanged). */
  fixtureDir: string;
  /** Primary hub's bare origin, if git-backed. */
  originPath?: string;
  /** Registered container paths keyed by container name. */
  containerPaths?: Record<string, string>;
  /** Pristine post-seed baselines keyed by container name. */
  baselinePaths?: Record<string, string>;
  /** Pristine post-seed workspace staging tree. */
  stagingBaselinePath?: string;
  /** Bare origins keyed by git-backed container name. */
  originPaths?: Record<string, string>;
  /** Commit count in the primary origin before the Copilot conversation. */
  baselineCommitCount?: number;
}

export type MakeTempRoot = (prefix: string) => Promise<string>;
export type RemoveTempRoot = (root: string) => Promise<void>;

export interface ProvisionEnvironmentOptions {
  repoRoot: string;
  label?: string;
  runner?: typeof run;
  makeTempRoot?: MakeTempRoot;
  removeTempRoot?: RemoveTempRoot;
}

const fixturePath = (f: string): string => (isAbsolute(f) ? f : resolve(EVAL_ROOT, f));

/** Register one hub into the OKH containers dir; seed a bare origin for git-auto. */
async function registerHub(
  hub: EnvHub,
  containersDir: string,
  root: string,
  git: Git,
  runner: typeof run,
): Promise<{ entry: ContainerEntry; originPath?: string }> {
  const fixtureDir = fixturePath(hub.fixture);
  if ((hub.backend ?? "local") === "git-auto") {
    const originPath = join(root, `${hub.container}-origin.git`);
    await runner("git", ["init", "--bare", "-b", "main", originPath]);
    const seed = join(root, `${hub.container}-seed`);
    await runner("git", ["clone", originPath, seed]);
    await cp(fixtureDir, seed, { recursive: true });
    await runner("git", ["add", "-A"], { cwd: seed });
    // Pin an identity so the seed commit never depends on the machine's global
    // git config (CI runners have none → "empty ident name").
    await runner(
      "git",
      ["-c", "user.name=OKH Eval", "-c", "user.email=eval@okh.invalid", "commit", "-m", "seed"],
      { cwd: seed },
    );
    await runner("git", ["push", "origin", "main"], { cwd: seed });
    const clone = join(containersDir, hub.container);
    await git.clone(originPath, clone);
    return {
      entry: { name: hub.container, backend: { type: "git", config: { origin: originPath } }, localPath: clone, sync: { mode: "auto", config: {} }, addedAt: new Date().toISOString() },
      originPath,
    };
  }
  const dir = join(containersDir, hub.container);
  await cp(fixtureDir, dir, { recursive: true });
  return { entry: { name: hub.container, backend: { type: "local", config: {} }, localPath: dir, sync: { mode: "auto", config: {} }, addedAt: new Date().toISOString() } };
}

async function commitSeededBaseline(
  entry: ContainerEntry,
  runner: typeof run,
): Promise<void> {
  await runner("git", ["add", "-A"], { cwd: entry.localPath });
  await runner(
    "git",
    [
      "-c",
      "user.name=OKH Eval",
      "-c",
      "user.email=eval@okh.invalid",
      "commit",
      "-m",
      "seed workspace lifecycle state",
    ],
    { cwd: entry.localPath },
  );
  await runner("git", ["push", "origin", "main"], { cwd: entry.localPath });
}

async function originCommitCount(originPath: string, runner: typeof run): Promise<number> {
  const { stdout } = await runner("git", ["--git-dir", originPath, "rev-list", "--count", "main"]);
  const count = Number(stdout.trim());
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`invalid baseline commit count for ${originPath}: ${JSON.stringify(stdout)}`);
  }
  return count;
}

/**
 * Build a fully isolated workspace for one eval run against a named environment:
 * an OKH_HOME (registry per the env), a COPILOT_HOME whose mcp-config launches the
 * built OKH server against that OKH_HOME, and a working directory.
 */
export async function provisionEnvironment(
  env: EnvName,
  opts: ProvisionEnvironmentOptions,
): Promise<Provisioned> {
  const def: Environment = environments[env];
  const runner = opts.runner ?? run;
  const makeTempRoot: MakeTempRoot = opts.makeTempRoot ?? ((prefix) => mkdtemp(prefix));
  const removeTempRoot: RemoveTempRoot = opts.removeTempRoot ?? ((root) => rm(root, { recursive: true, force: true }));
  const git = new Git(runner);

  const root = await makeTempRoot(join(tmpdir(), `okh-eval-${opts.label ?? env}-`));
  try {
    const okhHome = join(root, "okh-home");
    const copilotHome = join(root, "copilot-home");
    const workspace = join(root, "workspace");
    const containersDir = join(okhHome, "containers");
    await mkdir(containersDir, { recursive: true });
    await mkdir(copilotHome, { recursive: true });
    await mkdir(workspace, { recursive: true });

    const paths: OkhPaths = {
      home: okhHome,
      containersDir,
      registryFile: join(okhHome, "registry.json"),
      preferencesFile: join(okhHome, "preferences.json"),
    };

    const primary = def.hubs[0];
    const primaryFixtureDir = fixturePath(primary.fixture);
    let containerPath = "";
    let originPath: string | undefined;
    const registered = new Map<string, {
      hub: EnvHub;
      entry: ContainerEntry;
      originPath?: string;
    }>();

    if (def.placement === "workspace") {
      for (const hub of def.hubs) {
        const dest = join(workspace, hub.container);
        await cp(fixturePath(hub.fixture), dest, { recursive: true });
        if (hub === primary) containerPath = dest;
      }
      await saveRegistry(paths, emptyRegistry());
    } else {
      let registry = emptyRegistry();
      for (const hub of def.hubs) {
        const { entry, originPath: hubOrigin } = await registerHub(hub, containersDir, root, git, runner);
        registered.set(hub.container, { hub, entry, originPath: hubOrigin });
        registry = withContainerAdded(registry, entry);
        if (hub === primary) {
          containerPath = entry.localPath;
          originPath = hubOrigin;
        }
      }
      await saveRegistry(paths, registry);
    }

    const baselinePaths: Record<string, string> = {};
    let stagingBaselinePath: string | undefined;
    if (def.seed === "workspace") {
      await seedWorkspaceEnvironment(paths, runner);
      for (const { hub, entry } of registered.values()) {
        if ((hub.backend ?? "local") === "git-auto") {
          await commitSeededBaseline(entry, runner);
        }
      }
      const baselineRoot = join(root, "baselines");
      await mkdir(baselineRoot, { recursive: true });
      for (const [name, { entry }] of registered) {
        const baseline = join(baselineRoot, name);
        const gitDirectory = resolve(entry.localPath, ".git");
        await cp(entry.localPath, baseline, {
          recursive: true,
          filter: (source) => resolve(source) !== gitDirectory,
        });
        baselinePaths[name] = baseline;
      }
      stagingBaselinePath = join(root, "staging-baseline");
      await cp(join(okhHome, "workspace-staging"), stagingBaselinePath, { recursive: true });
    }

    if (def.workspaceDir) {
      await cp(fixturePath(def.workspaceDir), workspace, { recursive: true });
    }

    await writeMcpConfig(copilotHome, opts.repoRoot, okhHome);
    const containerPaths = Object.fromEntries(
      [...registered].map(([name, value]) => [name, value.entry.localPath]),
    );
    const originPaths = Object.fromEntries(
      [...registered]
        .filter(([, value]) => value.originPath !== undefined)
        .map(([name, value]) => [name, value.originPath!]),
    );
    const baselineCommitCount = originPath
      ? await originCommitCount(originPath, runner)
      : undefined;
    return {
      root,
      okhHome,
      copilotHome,
      workspace,
      containerPath,
      fixtureDir: baselinePaths[primary.container] ?? primaryFixtureDir,
      originPath,
      containerPaths,
      baselinePaths,
      stagingBaselinePath,
      originPaths,
      baselineCommitCount,
    };
  } catch (provisionError) {
    try {
      await removeTempRoot(root);
    } catch (cleanupError) {
      throw new AggregateError(
        [provisionError, cleanupError],
        `Failed to provision eval environment "${env}" and clean up temp root "${root}".`,
      );
    }
    throw provisionError;
  }
}

async function writeMcpConfig(copilotHome: string, repoRoot: string, okhHome: string): Promise<void> {
  const mcp = {
    mcpServers: {
      "open-knowledge-hub": {
        command: "node",
        args: [join(repoRoot, "dist", "index.js")],
        env: { OKH_HOME: okhHome },
      },
    },
  };
  await writeFile(join(copilotHome, "mcp-config.json"), `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
}
