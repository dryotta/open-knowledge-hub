import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { EnvName } from "./environments.js";

export interface RunRecord {
  env: EnvName;
  root: string;
  workspace: string;
  copilotHome: string;
  createdAt: string;
}

/** Disposable pointer file: which temp runs `setup` has provisioned. */
export const DEFAULT_STATE_FILE = join(tmpdir(), "okh-eval-state.json");

interface StateShape {
  runs: RunRecord[];
}

/** Read recorded runs; missing/malformed file => empty list. */
export async function readRuns(stateFile: string = DEFAULT_STATE_FILE): Promise<RunRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as Partial<StateShape>;
    return Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch {
    return [];
  }
}

async function writeRuns(runs: RunRecord[], stateFile: string): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, `${JSON.stringify({ runs }, null, 2)}\n`, "utf8");
  await rename(tmp, stateFile);
}

/** Upsert by env; the re-recorded entry becomes the most-recent (last). */
export async function recordRun(rec: RunRecord, stateFile: string = DEFAULT_STATE_FILE): Promise<void> {
  const runs = (await readRuns(stateFile)).filter((r) => r.env !== rec.env);
  runs.push(rec);
  await writeRuns(runs, stateFile);
}

/** Resolve a run by env name, or the most-recent when omitted. Throws with guidance. */
export async function resolveRun(
  env: string | undefined,
  stateFile: string = DEFAULT_STATE_FILE,
): Promise<RunRecord> {
  const runs = await readRuns(stateFile);
  if (runs.length === 0) {
    throw new Error("No provisioned run found — run 'npm run eval:setup -- setup <env>' first.");
  }
  const rec = env
    ? [...runs].reverse().find((r) => r.env === env)
    : runs[runs.length - 1];
  if (!rec) {
    throw new Error(`No provisioned run for env "${env}" — run 'npm run eval:setup -- setup ${env}' first.`);
  }
  if (!existsSync(rec.root)) {
    throw new Error(`Run directory is gone (${rec.root}) — re-run 'npm run eval:setup -- setup ${rec.env}'.`);
  }
  return rec;
}

/** Drop the entry with the given root (used after `clean`). */
export async function forgetRun(root: string, stateFile: string = DEFAULT_STATE_FILE): Promise<void> {
  const runs = (await readRuns(stateFile)).filter((r) => r.root !== root);
  await writeRuns(runs, stateFile);
}
