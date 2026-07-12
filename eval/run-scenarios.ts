import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * Runs the single default eval config (`eval/promptfooconfig.yaml`) in ONE
 * promptfoo process. The config pulls every case in via `scenarios:` (a
 * `file://scenarios/**\/*.yaml` glob) with a single `{{prompt}}` pass-through,
 * so promptfoo runs them concurrently with no prompt×test cross-product.
 *
 *   npm run eval          → `promptfoo eval -c eval/promptfooconfig.yaml --no-cache`
 *   npm run eval:validate → `promptfoo validate -c eval/promptfooconfig.yaml`
 *
 * Invoked through `node --import tsx` so the TypeScript provider/assertions
 * load with NodeNext `.js` import specifiers.
 */
const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(EVAL_ROOT, "..");
const CONFIG = join(EVAL_ROOT, "promptfooconfig.yaml");
// Resolve through Node.js module resolution so the path works whether promptfoo
// lives in a local node_modules/ or in a parent directory (e.g. git worktrees).
// _require.resolve("promptfoo") returns the CJS entry (dist/src/index.cjs);
// entrypoint.js lives in the same directory.
const _require = createRequire(import.meta.url);
const PROMPTFOO = join(dirname(_require.resolve("promptfoo")), "entrypoint.js");

function run(mode: "eval" | "validate"): Promise<number> {
  const args = ["--import", "tsx", PROMPTFOO, mode, "-c", CONFIG];
  if (mode === "eval") args.push("--no-cache");
  return new Promise((res) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", cwd: REPO_ROOT });
    child.on("close", (code) => res(code ?? 1));
    child.on("error", () => res(1));
  });
}

const mode: "eval" | "validate" = process.argv[2] === "validate" ? "validate" : "eval";
run(mode)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
