import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Runs the scenario configs **one file at a time** — one `promptfoo` process per
 * config — instead of globbing them into a single run. Each config is a complete,
 * standalone promptfoo config (one prompt + one test), so running them separately
 * keeps every eval isolated and avoids promptfoo's prompt×test cross-product.
 *
 *   npm run eval            → `promptfoo eval -c <file> --no-cache` per config
 *   npm run eval:validate   → `promptfoo validate -c <file>` per config
 *
 * Exits non-zero if any config fails.
 */
const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(EVAL_ROOT, "..");
const SCENARIOS = join(EVAL_ROOT, "scenarios");
const PROMPTFOO = resolve(REPO_ROOT, "node_modules", "promptfoo", "dist", "src", "entrypoint.js");

/** Every scenario config (verb/<name>.yaml), recursively, skipping the shared/ folder. */
async function configFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (ent.name === "shared") continue;
        await walk(join(dir, ent.name));
      } else if (ent.name.endsWith(".yaml")) {
        out.push(join(dir, ent.name));
      }
    }
  };
  await walk(SCENARIOS);
  return out.sort();
}

function runOne(mode: "eval" | "validate", file: string): Promise<number> {
  const args = ["--import", "tsx", PROMPTFOO, mode, "-c", file];
  if (mode === "eval") args.push("--no-cache");
  return new Promise((res) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", cwd: REPO_ROOT });
    child.on("close", (code) => res(code ?? 1));
    child.on("error", () => res(1));
  });
}

async function main(): Promise<number> {
  const mode: "eval" | "validate" = process.argv[2] === "validate" ? "validate" : "eval";
  const files = await configFiles();
  if (files.length === 0) throw new Error(`no scenario configs found under ${SCENARIOS}`);

  const failures: string[] = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    console.log(`\n=== ${mode}: ${rel} ===`);
    if ((await runOne(mode, file)) !== 0) failures.push(rel);
  }

  console.log(`\n${mode}: ${files.length - failures.length}/${files.length} config(s) passed`);
  if (failures.length > 0) {
    console.log("failed:");
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
