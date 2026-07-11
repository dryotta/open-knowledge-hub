import { join } from "node:path";
import { readTree, diffTrees } from "./_compare.js";

interface Ctx {
  config?: { module?: string; observation?: string };
  providerResponse?: { metadata?: { containerPath?: string; fixtureDir?: string } };
}

const ISO_TIMESTAMP_RE = /^## \d{4}-\d{2}-\d{2}T\S+$/;

/**
 * Pass iff the memory module gained exactly one new/changed Markdown entry containing
 * exactly one ISO timestamp heading and the configured observation preserved verbatim.
 * Prior content must not be rewritten/deleted (append-only).
 */
export default async function memoryAppend(_output: string, context: Ctx) {
  const meta = context.providerResponse?.metadata ?? {};
  const module = context.config?.module ?? "mem";
  const observation = context.config?.observation;

  if (!observation || observation.trim() === "") {
    return { pass: false, score: 0, reason: "observation config is required but missing or empty" };
  }
  if (!meta.containerPath) return { pass: false, score: 0, reason: "no containerPath in metadata" };
  if (!meta.fixtureDir) return { pass: false, score: 0, reason: "no fixtureDir in metadata" };

  const before = await readTree(join(meta.fixtureDir, module));
  const after = await readTree(join(meta.containerPath, module));
  const d = diffTrees(before, after);

  // Reject any removed Markdown file
  const removedMd = d.removed.filter((f) => f.endsWith(".md"));
  if (removedMd.length > 0) {
    return { pass: false, score: 0, reason: `removed Markdown file(s): ${removedMd.join(", ")}` };
  }

  // Reject changed files whose after content does not start with prior content
  const changedMd = d.changed.filter((f) => f.endsWith(".md"));
  for (const f of changedMd) {
    const priorContent = before.get(f)!;
    const afterContent = after.get(f)!;
    if (!afterContent.startsWith(priorContent)) {
      return { pass: false, score: 0, reason: `prior content rewritten in ${f}` };
    }
  }

  // Collect added-or-changed Markdown paths
  const addedMd = d.added.filter((f) => f.endsWith(".md"));
  const candidates = [...addedMd, ...changedMd];

  if (candidates.length === 0) {
    return { pass: false, score: 0, reason: "no added or changed Markdown file" };
  }
  if (candidates.length > 1) {
    return { pass: false, score: 0, reason: `expected exactly one added/changed Markdown file, found ${candidates.length}: ${candidates.join(", ")}` };
  }

  // Determine appended text
  const target = candidates[0];
  const afterContent = after.get(target)!;
  let appended: string;
  if (addedMd.includes(target)) {
    appended = afterContent;
  } else {
    appended = afterContent.slice(before.get(target)!.length);
  }

  // Require exactly one ISO timestamp heading
  const lines = appended.split("\n");
  const timestampLines = lines.filter((l) => ISO_TIMESTAMP_RE.test(l));
  if (timestampLines.length === 0) {
    return { pass: false, score: 0, reason: "no ISO timestamp heading found in appended content" };
  }
  if (timestampLines.length > 1) {
    return { pass: false, score: 0, reason: `expected exactly one timestamp heading, found ${timestampLines.length}` };
  }

  // Require the exact observation preserved verbatim and appearing exactly once
  const occurrences = countExact(appended, observation);
  if (occurrences === 0) {
    return { pass: false, score: 0, reason: "observation not found verbatim in appended content" };
  }
  if (occurrences > 1) {
    return { pass: false, score: 0, reason: `observation appears ${occurrences} times (expected exactly once)` };
  }

  // Validate no extra non-empty lines beyond: timestamp heading, observation lines, blank lines,
  // and an optional file-date heading for a newly added file (e.g. "# 2026-07-02")
  const violations = findExtraLines(lines, timestampLines[0], observation, addedMd.includes(target));
  if (violations.length > 0) {
    return { pass: false, score: 0, reason: `extra non-empty line(s): ${violations.map((v) => JSON.stringify(v)).join("; ")}` };
  }

  return { pass: true, score: 1, reason: `appended verbatim observation with timestamp ${timestampLines[0]}` };
}

function countExact(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while (true) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

function findExtraLines(
  lines: string[],
  timestampHeading: string,
  observation: string,
  isNewFile: boolean,
): string[] {
  const observationLines = observation.split("\n");
  const allowed = new Set<number>();

  // Allow blank lines
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") allowed.add(i);
  }

  // Allow the timestamp heading line
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === timestampHeading) { allowed.add(i); break; }
  }

  // Allow observation lines (find exact contiguous match)
  const obsStart = findContiguousMatch(lines, observationLines);
  if (obsStart >= 0) {
    for (let i = obsStart; i < obsStart + observationLines.length; i++) {
      allowed.add(i);
    }
  }

  // Allow optional file-date heading for newly added file (e.g. "# 2026-07-02")
  if (isNewFile) {
    for (let i = 0; i < lines.length; i++) {
      if (/^# \d{4}-\d{2}-\d{2}$/.test(lines[i])) { allowed.add(i); break; }
    }
  }

  const violations: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!allowed.has(i) && lines[i].trim() !== "") {
      violations.push(lines[i]);
    }
  }
  return violations;
}

function findContiguousMatch(lines: string[], target: string[]): number {
  if (target.length === 0) return -1;
  for (let i = 0; i <= lines.length - target.length; i++) {
    let match = true;
    for (let j = 0; j < target.length; j++) {
      if (lines[i + j] !== target[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

