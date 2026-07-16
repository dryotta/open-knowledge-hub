import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { OkhPaths } from "./config.js";
import { Mutex } from "./util/mutex.js";

export const DEFAULT_WAKE_PHRASE = "hub";

/** 1-32 chars: a letter, then letters, digits or dashes. */
export const wakePhraseSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/i, "wake phrase must be 1-32 chars: a letter then letters, digits or dashes");

export const preferencesSchema = z
  .object({ wakePhrase: wakePhraseSchema.default(DEFAULT_WAKE_PHRASE) })
  .passthrough();
export type Preferences = z.infer<typeof preferencesSchema>;

/** Human-facing metadata for each configurable key. Keep in sync with preferencesSchema. */
export const configFieldMeta: ReadonlyArray<{ key: keyof Preferences; description: string }> = [
  {
    key: "wakePhrase",
    description:
      'Short phrase used to address the hub (1-32 chars: a letter then letters, digits or dashes; default "hub"). Takes effect on the next client restart.',
  },
];

/** The list of known/valid config keys, derived from configFieldMeta. */
export const configKeys: readonly string[] = configFieldMeta.map((f) => f.key);

const mutex = new Mutex();

function parseOrDefault(raw: string): Preferences {
  try {
    const parsed = preferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { wakePhrase: DEFAULT_WAKE_PHRASE };
  } catch {
    return { wakePhrase: DEFAULT_WAKE_PHRASE };
  }
}

export async function loadPreferences(paths: OkhPaths): Promise<Preferences> {
  try {
    return parseOrDefault(await readFile(paths.preferencesFile, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { wakePhrase: DEFAULT_WAKE_PHRASE };
    throw err;
  }
}

export function loadPreferencesSync(paths: OkhPaths): Preferences {
  try {
    return parseOrDefault(readFileSync(paths.preferencesFile, "utf8"));
  } catch {
    return { wakePhrase: DEFAULT_WAKE_PHRASE };
  }
}

export function savePreferences(paths: OkhPaths, prefs: Preferences): Promise<void> {
  return mutex.run(async () => {
    const validated = preferencesSchema.parse(prefs);
    await mkdir(dirname(paths.preferencesFile), { recursive: true });
    const tmp = `${paths.preferencesFile}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await rename(tmp, paths.preferencesFile);
  });
}
