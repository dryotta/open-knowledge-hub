import { mkdir, mkdtemp, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/exec.js";
import { Git } from "../src/git/git.js";
import { emptyRegistry, type ContainerEntry } from "../src/registry/schema.js";
import { saveRegistry, withContainerAdded } from "../src/registry/registry.js";
import type { OkhPaths } from "../src/config.js";

export type EvalBackend = "local" | "git-auto";

export interface ProvisionInput {
  scenario: string;
  backend: EvalBackend;
  container: string;
  /** Absolute path to the fixture container directory to copy. */
  fixtureDir: string;
  /** Absolute path to the OKH repo root (for dist/index.js in mcp-config). */
  repoRoot: string;
  /** Injectable process runner (tests pass a git-identity-bound runner). */
  runner?: typeof run;
}

export interface Provisioned {
  /** Temp root holding everything for this run. */
  root: string;
  okhHome: string;
  copilotHome: string;
  workspace: string;
  containerPath: string;
  originPath?: string;
}

/**
 * Build a fully isolated workspace for one eval run: an OKH_HOME with a
 * registered container (copied from the fixture), a COPILOT_HOME with an
 * mcp-config that launches the built OKH server against that OKH_HOME, and an
 * empty working directory. For git-auto, a throwaway bare origin is seeded and
 * cloned so `sync` has somewhere to push.
 */
export async function provision(input: ProvisionInput): Promise<Provisioned> {
  const runner = input.runner ?? run;
  const git = new Git(runner);

  const root = await mkdtemp(join(tmpdir(), `okh-eval-${input.scenario}-`));
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
  let entry: ContainerEntry;
  let originPath: string | undefined;

  if (input.backend === "git-auto") {
    originPath = join(root, "origin.git");
    await runner("git", ["init", "--bare", "-b", "main", originPath]);
    const seed = join(root, "seed");
    await runner("git", ["clone", originPath, seed]);
    await cp(input.fixtureDir, seed, { recursive: true });
    await runner("git", ["add", "-A"], { cwd: seed });
    await runner("git", ["commit", "-m", "seed"], { cwd: seed });
    await runner("git", ["push", "origin", "main"], { cwd: seed });
    const clone = join(containersDir, input.container);
    await git.clone(originPath, clone);
    entry = { name: input.container, backend: "git", origin: originPath, localPath: clone, addedAt: new Date().toISOString() };
  } else {
    const dir = join(containersDir, input.container);
    await cp(input.fixtureDir, dir, { recursive: true });
    entry = { name: input.container, backend: "local", localPath: dir, addedAt: new Date().toISOString() };
  }

  await saveRegistry(paths, withContainerAdded(emptyRegistry(), entry));

  const mcp = {
    mcpServers: {
      "open-knowledge-hub": {
        command: "node",
        args: [join(input.repoRoot, "dist", "index.js")],
        env: { OKH_HOME: okhHome },
      },
    },
  };
  await writeFile(join(copilotHome, "mcp-config.json"), `${JSON.stringify(mcp, null, 2)}\n`, "utf8");

  return { root, okhHome, copilotHome, workspace, containerPath: entry.localPath, originPath };
}
