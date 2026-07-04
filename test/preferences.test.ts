import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import {
  loadPreferences,
  loadPreferencesSync,
  savePreferences,
  DEFAULT_WAKE_PHRASE,
  configFieldMeta,
  configKeys,
  preferencesSchema,
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

  it("exposes config metadata keys aligned with the schema", () => {
    expect(configKeys).toContain("wakePhrase");
    const wake = configFieldMeta.find((f) => f.key === "wakePhrase");
    expect(wake).toBeDefined();
    expect(wake!.description.length).toBeGreaterThan(0);
    // configKeys must exactly cover the schema's keys, so it can't drift when a field is added/removed
    expect(configKeys).toEqual(Object.keys(preferencesSchema.shape));
  });
});
