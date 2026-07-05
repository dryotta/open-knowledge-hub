import { mkdir, mkdtemp, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { run } from "../src/exec.js";
import { Git } from "../src/git/git.js";
import { emptyRegistry, type ContainerEntry } from "../src/registry/schema.js";
import { saveRegistry, withContainerAdded } from "../src/registry/registry.js";
import type { OkhPaths } from "../src/config.js";

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
}

export const environments = {
  empty: {
    placement: "workspace",
    hubs: [{ container: "notes", fixture: "fixtures/plain-notes" }],
  },
  git: {
    placement: "registered",
    hubs: [{ container: "git-hub", fixture: "fixtures/git-hub", backend: "git-auto" }],
  },
  "local-and-git": {
    placement: "registered",
    hubs: [
      { container: "kb-hub", fixture: "fixtures/kb-hub", backend: "local" },
      { container: "git-hub", fixture: "fixtures/git-hub", backend: "git-auto" },
    ],
  },
} satisfies Record<string, Environment>;

export type EnvName = keyof typeof environments;

export function isEnvName(v: unknown): v is EnvName {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(environments, v);
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
      entry: { name: hub.container, backend: "git", origin: originPath, localPath: clone, addedAt: new Date().toISOString() },
      originPath,
    };
  }
  const dir = join(containersDir, hub.container);
  await cp(fixtureDir, dir, { recursive: true });
  return { entry: { name: hub.container, backend: "local", localPath: dir, addedAt: new Date().toISOString() } };
}

/**
 * Build a fully isolated workspace for one eval run against a named environment:
 * an OKH_HOME (registry per the env), a COPILOT_HOME whose mcp-config launches the
 * built OKH server against that OKH_HOME, and a working directory.
 */
export async function provisionEnvironment(
  env: EnvName,
  opts: { repoRoot: string; label?: string; runner?: typeof run },
): Promise<Provisioned> {
  const def = environments[env];
  const runner = opts.runner ?? run;
  const git = new Git(runner);

  const root = await mkdtemp(join(tmpdir(), `okh-eval-${opts.label ?? env}-`));
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
      registry = withContainerAdded(registry, entry);
      if (hub === primary) {
        containerPath = entry.localPath;
        originPath = hubOrigin;
      }
    }
    await saveRegistry(paths, registry);
  }

  await writeMcpConfig(copilotHome, opts.repoRoot, okhHome);
  return { root, okhHome, copilotHome, workspace, containerPath, fixtureDir: primaryFixtureDir, originPath };
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
