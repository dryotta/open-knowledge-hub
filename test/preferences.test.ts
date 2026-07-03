import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import {
  loadPreferences,
  loadPreferencesSync,
  savePreferences,
  DEFAULT_WAKE_PHRASE,
} from "../src/preferences.js";
import { makePaths, makeTempDir } from "./helpers.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function paths() {
  const home = await makeTempDir(); cleanups.push(home);
  return makePaths(home);
}

describe("preferences", () => {
  it("defaults to 'hub' when absent (async + sync)", async () => {
    const p = await paths();
    expect((await loadPreferences(p)).wakePhrase).toBe(DEFAULT_WAKE_PHRASE);
    expect(loadPreferencesSync(p).wakePhrase).toBe(DEFAULT_WAKE_PHRASE);
    expect(DEFAULT_WAKE_PHRASE).toBe("hub");
  });

  it("round-trips a custom phrase", async () => {
    const p = await paths();
    await savePreferences(p, { wakePhrase: "brain" });
    expect((await loadPreferences(p)).wakePhrase).toBe("brain");
    expect(loadPreferencesSync(p).wakePhrase).toBe("brain");
  });

  it("rejects an invalid phrase on save", async () => {
    const p = await paths();
    await expect(savePreferences(p, { wakePhrase: "no spaces" })).rejects.toBeTruthy();
  });

  it("falls back to default on a malformed file", async () => {
    const p = await paths();
    await writeFile(p.preferencesFile, "{ not json", "utf8");
    expect((await loadPreferences(p)).wakePhrase).toBe(DEFAULT_WAKE_PHRASE);
  });
});
