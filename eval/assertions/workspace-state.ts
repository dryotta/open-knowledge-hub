import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { run } from "../../src/exec.js";
import {
  readEvents,
  runHistory,
  successfulResults,
} from "../../src/workspaces/events.js";
import {
  fileEtag,
  inspectResultTree,
} from "../../src/workspaces/files.js";
import { parseProjectReadme } from "../../src/workspaces/markdown.js";
import type {
  AcceptanceCriterion,
  ProjectRecord,
  ResultRecord,
  WorkspaceEvent,
} from "../../src/workspaces/types.js";

type Mode =
  | "completed-presentation"
  | "guided-investigation"
  | "revised-presentation"
  | "cancelled-attention"
  | "restored-archived"
  | "concurrent-run-rejected"
  | "ambiguous-read-only";

interface TurnMetadata {
  finalMessage?: string;
}

interface Metadata {
  okhHome?: string;
  containerPaths?: Record<string, string>;
  baselinePaths?: Record<string, string>;
  stagingBaselinePath?: string;
  originPath?: string;
  baselineCommitCount?: number;
  finalMessage?: string;
  turns?: TurnMetadata[];
}

interface Ctx {
  config?: { mode?: Mode };
  providerResponse?: { metadata?: Metadata };
}

interface Result {
  pass: boolean;
  score: number;
  reason: string;
}

interface ProjectData {
  containerRoot: string;
  moduleRoot: string;
  projectRoot: string;
  project: ProjectRecord;
  events: WorkspaceEvent[];
  results: ResultRecord[];
}

type FileTree = Map<string, string>;

const fail = (reason: string): Result => ({ pass: false, score: 0, reason });

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null || value === "") throw new Error(message);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function paths(meta: Metadata): {
  work: string;
  personal: string;
  workBaseline: string;
  personalBaseline: string;
  okhHome: string;
} {
  return {
    work: requireValue(meta.containerPaths?.["work-hub"], "missing work-hub path"),
    personal: requireValue(meta.containerPaths?.["personal-hub"], "missing personal-hub path"),
    workBaseline: requireValue(meta.baselinePaths?.["work-hub"], "missing work-hub baseline"),
    personalBaseline: requireValue(meta.baselinePaths?.["personal-hub"], "missing personal-hub baseline"),
    okhHome: requireValue(meta.okhHome, "missing OKH home"),
  };
}

async function projectData(
  root: string,
  module: string,
  projectId: string,
): Promise<ProjectData> {
  const moduleRoot = join(root, module);
  const projectRoot = join(moduleRoot, "projects", projectId);
  const readme = join(projectRoot, "README.md");
  const project = parseProjectReadme(
    projectId,
    await readFile(readme, "utf8"),
    await fileEtag(readme, moduleRoot),
  );
  const events = await readEvents(join(projectRoot, "events.json"), moduleRoot);
  return {
    containerRoot: root,
    moduleRoot,
    projectRoot,
    project,
    events,
    results: successfulResults(events),
  };
}

function committedTypes(events: readonly WorkspaceEvent[], afterSequence = 0): string[] {
  return events
    .filter((event) => event.sequence > afterSequence && event.type.endsWith(".committed"))
    .map((event) =>
      event.type
        .replace(/^dev\.okh\.workspace\./u, "")
        .replace(/\.committed$/u, ""));
}

export function committedSequenceMatches(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function assertProjectDefinitionUnchanged(
  before: ProjectRecord,
  after: ProjectRecord,
  label: string,
): void {
  assert(after.id === before.id, `${label} project id changed`);
  assert(after.title === before.title, `${label} title changed`);
  assert(after.createdAt === before.createdAt, `${label} creation time changed`);
  assert(after.targetDate === before.targetDate, `${label} target date changed`);
  assert(after.goal === before.goal, `${label} goal changed`);
  assert(after.guidance === before.guidance, `${label} guidance changed`);
  assert(
    JSON.stringify(after.tags) === JSON.stringify(before.tags),
    `${label} tags changed`,
  );
  assert(
    JSON.stringify(after.acceptance) === JSON.stringify(before.acceptance),
    `${label} acceptance criteria changed`,
  );
}

async function fingerprintTree(root: string): Promise<FileTree> {
  const files = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        const path = relative(root, absolute).replace(/\\/gu, "/");
        files.set(path, `${bytes.byteLength}:${createHash("sha256").update(bytes).digest("hex")}`);
      } else {
        files.set(
          relative(root, absolute).replace(/\\/gu, "/"),
          `non-file:${entry.isSymbolicLink() ? "symlink" : "other"}`,
        );
      }
    }
  };
  await walk(root);
  return files;
}

function treeDiff(before: FileTree, after: FileTree): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  const changed = [...after.keys()]
    .filter((path) => before.has(path) && before.get(path) !== after.get(path))
    .sort();
  return { added, removed, changed };
}

async function assertTreeUnchanged(beforeRoot: string, afterRoot: string, label: string): Promise<void> {
  const diff = treeDiff(
    await fingerprintTree(beforeRoot),
    await fingerprintTree(afterRoot),
  );
  assert(
    diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0,
    `${label} changed: added[${diff.added.join(", ")}] removed[${diff.removed.join(", ")}] changed[${diff.changed.join(", ")}]`,
  );
}

async function assertOnlyPathsChanged(
  beforeRoot: string,
  afterRoot: string,
  allowed: (path: string) => boolean,
  label = "workspace",
): Promise<void> {
  const diff = treeDiff(
    await fingerprintTree(beforeRoot),
    await fingerprintTree(afterRoot),
  );
  const unexpected = [...diff.added, ...diff.removed, ...diff.changed]
    .filter((path) => !allowed(path));
  assert(unexpected.length === 0, `unexpected ${label} changes: ${unexpected.join(", ")}`);
}

function stagingRoots(meta: Metadata): { before: string; after: string } {
  return {
    before: requireValue(meta.stagingBaselinePath, "missing staging baseline"),
    after: join(requireValue(meta.okhHome, "missing OKH home"), "workspace-staging"),
  };
}

async function assertStagingUnchanged(meta: Metadata): Promise<void> {
  const staging = stagingRoots(meta);
  await assertTreeUnchanged(staging.before, staging.after, "workspace staging");
}

async function assertOnlyStagingPathsChanged(
  meta: Metadata,
  allowed: (path: string) => boolean,
): Promise<void> {
  const staging = stagingRoots(meta);
  await assertOnlyPathsChanged(staging.before, staging.after, allowed, "workspace staging");
}

function resultRoot(data: ProjectData, result: ResultRecord): string {
  return join(data.projectRoot, ...result.path.split("/"));
}

async function resultText(data: ProjectData, result: ResultRecord): Promise<string> {
  const root = resultRoot(data, result);
  const markdown = result.files.filter((file) => /\.md$/iu.test(file.path));
  assert(markdown.length > 0, `result ${result.runId} contains no Markdown file`);
  return (await Promise.all(
    markdown.map((file) => readFile(join(root, ...file.path.split("/")), "utf8")),
  )).join("\n");
}

async function assertResultValid(data: ProjectData, result: ResultRecord): Promise<void> {
  const inspected = await inspectResultTree(resultRoot(data, result), data.moduleRoot);
  assert(inspected.treeHash === result.treeHash, `result ${result.runId} tree hash changed`);
  assert(
    JSON.stringify(inspected.files) === JSON.stringify(result.files),
    `result ${result.runId} file metadata changed`,
  );
  const start = data.events.find(
    (event) =>
      event.type === "dev.okh.workspace.run.started.committed"
      && event.subject === `runs/${result.runId}`,
  );
  assert(start, `result ${result.runId} has no committed start event`);
  const criteria = Array.isArray(start.data.criteria)
    ? start.data.criteria as AcceptanceCriterion[]
    : [];
  assert(criteria.length > 0, `run ${result.runId} froze no acceptance criteria`);
  assert(result.evidence.length === criteria.length, `run ${result.runId} evidence count is incomplete`);
  const files = new Set(result.files.map((file) => file.path));
  for (const criterion of criteria) {
    const evidence = result.evidence.find((entry) => entry.criterion === criterion.id);
    assert(evidence, `run ${result.runId} lacks evidence for ${criterion.id}`);
    for (const reference of evidence.references) {
      const path = reference.split("#", 1)[0]!.replace(/^\.\//u, "");
      assert(files.has(path), `evidence reference ${reference} does not name a result file`);
    }
  }
}

function assertPatterns(text: string, patterns: readonly RegExp[], label: string): void {
  const missing = patterns.filter((pattern) => !pattern.test(text));
  assert(missing.length === 0, `${label} misses ${missing.map(String).join(", ")}`);
}

async function assertPriorResultsUnchanged(
  before: ProjectData,
  after: ProjectData,
): Promise<void> {
  for (const result of before.results) {
    const current = after.results.find((candidate) => candidate.runId === result.runId);
    assert(current, `prior result ${result.runId} disappeared`);
    assert(current.treeHash === result.treeHash, `prior result ${result.runId} metadata changed`);
    await assertTreeUnchanged(
      resultRoot(before, result),
      resultRoot(after, current),
      `prior result ${result.runId}`,
    );
  }
}

async function assertOriginUnchanged(meta: Metadata): Promise<void> {
  const origin = requireValue(meta.originPath, "missing work-hub origin");
  const expected = requireValue(meta.baselineCommitCount, "missing baseline commit count");
  const { stdout } = await run("git", ["--git-dir", origin, "rev-list", "--count", "main"]);
  assert(Number(stdout.trim()) === expected, `origin commit count changed from ${expected}`);
}

async function completedPresentation(meta: Metadata): Promise<string> {
  const p = paths(meta);
  const data = await projectData(p.work, "presentations", "q3-launch-readiness");
  assert(data.project.status === "active", "new presentation is not active");
  assert(data.project.activeRun === null, "new presentation still has an active run");
  assert(data.project.targetDate === undefined, "project inferred a target-date year the user did not supply");
  assert(data.results.length === 1, `expected one result, found ${data.results.length}`);
  const current = data.results[0]!;
  assert(data.project.result === current.path, "new result is not current");
  await assertResultValid(data, current);
  const text = await resultText(data, current);
  assertPatterns(text, [
    /september\s+15/iu,
    /\b42\b/u,
    /\b36\b/u,
    /(?:three|3)[ -]day/iu,
    /guided onboarding/iu,
    /delay(?:ing)?(?:\s+the)?(?:\s+september\s+15)?\s+launch|launch is delayed/iu,
    /recommendation/iu,
    /evidence/iu,
    /risk/iu,
    /next steps?/iu,
    /source boundaries/iu,
  ], "presentation result");
  assert(
    committedSequenceMatches(
      committedTypes(data.events),
      ["project.created", "run.started", "run.succeeded"],
    ),
    "presentation lifecycle events are incomplete or out of order",
  );
  await assertOnlyPathsChanged(
    p.workBaseline,
    p.work,
    (path) => path.startsWith("presentations/projects/q3-launch-readiness/"),
  );
  await assertTreeUnchanged(p.personalBaseline, p.personal, "personal-hub");
  await assertOnlyStagingPathsChanged(
    meta,
    (path) => path.startsWith(`work-hub/presentations/q3-launch-readiness/${current.runId}/`),
  );
  return `published valid presentation result ${current.runId}`;
}

async function guidedInvestigation(meta: Metadata): Promise<string> {
  const p = paths(meta);
  const data = await projectData(p.work, "investigations", "checkout-rollout-choice");
  assert(data.project.status === "active", "guided investigation is not active");
  assert(data.project.activeRun === null, "guided investigation still has an active run");
  assert(data.results.length === 1, `expected one result, found ${data.results.length}`);
  const starts = data.events.filter(
    (event) => event.type === "dev.okh.workspace.run.started.committed",
  );
  assert(starts.length === 1, `expected one run start, found ${starts.length}`);
  const runId = starts[0]!.subject!.replace(/^runs\//u, "");
  const history = runHistory(data.events, runId);
  assert(history.state === "succeeded", `guided run ended in ${history.state}`);
  assert(
    history.guidance.some((entry) =>
      /prioritize reliability/iu.test(entry.text)
      && /\$?50,?000/u.test(entry.text)),
    "durable reliability guidance or its cost tradeoff is missing",
  );
  assert(history.guidance.length === 1, `expected one guidance record, found ${history.guidance.length}`);
  assert(
    committedSequenceMatches(
      committedTypes(data.events),
      ["project.created", "run.started", "run.paused", "run.guided", "run.succeeded"],
    ),
    "guided run did not follow create/start/pause/guide/succeed",
  );
  const current = data.results[0]!;
  assert(data.project.result === current.path, "guided result is not current");
  await assertResultValid(data, current);
  const text = await resultText(data, current);
  assertPatterns(text, [
    /blue\/green/iu,
    /\$?120,?000/u,
    /\$?70,?000/u,
    /\b2%/u,
    /\b8%/u,
    /\$?50,?000/u,
    /reliability/iu,
    /source boundaries/iu,
  ], "investigation result");
  await assertOnlyPathsChanged(
    p.workBaseline,
    p.work,
    (path) => path.startsWith("investigations/projects/checkout-rollout-choice/"),
  );
  await assertTreeUnchanged(p.personalBaseline, p.personal, "personal-hub");
  await assertOnlyStagingPathsChanged(
    meta,
    (path) => path.startsWith(`work-hub/investigations/checkout-rollout-choice/${runId}/`),
  );
  return `guided and completed run ${runId}`;
}

async function revisedPresentation(meta: Metadata): Promise<string> {
  const p = paths(meta);
  const before = await projectData(p.workBaseline, "presentations", "launch-readiness");
  const after = await projectData(p.work, "presentations", "launch-readiness");
  assert(before.project.status === "archived", "seeded presentation was not archived");
  assert(after.project.status === "active", "reopened presentation is not active");
  assert(after.project.activeRun === null, "revision still has an active run");
  assert(after.results.length === before.results.length + 1, "revision did not add exactly one result");
  assertProjectDefinitionUnchanged(before.project, after.project, "revision");
  await assertPriorResultsUnchanged(before, after);
  const current = after.results.find((result) => result.path === after.project.result);
  assert(current, "new revision is not the current result");
  assert(!before.results.some((result) => result.runId === current.runId), "current result is not new");
  await assertResultValid(after, current);
  const text = await resultText(after, current);
  assertPatterns(text, [
    /decision matrix/iu,
    /guided onboarding/iu,
    /delay(?:ing)? launch/iu,
    /recommend(?:ation|ed)[\s\S]{0,100}guided onboarding/iu,
    /september\s+15/iu,
    /\b42\b/u,
    /\b36\b/u,
    /(?:three|3)[ -]day/iu,
    /source boundaries/iu,
  ], "revised presentation");
  assert(
    committedSequenceMatches(
      committedTypes(after.events, before.events.at(-1)?.sequence ?? 0),
      ["project.unarchived", "run.started", "run.succeeded"],
    ),
    "revision lifecycle is incomplete or out of order",
  );
  await assertOnlyPathsChanged(
    p.workBaseline,
    p.work,
    (path) =>
      path === "presentations/projects/launch-readiness/README.md"
      || path === "presentations/projects/launch-readiness/events.json"
      || (
        path.startsWith("presentations/projects/launch-readiness/runs/")
        && path.includes(`/${current.runId}/`)
      ),
  );
  await assertTreeUnchanged(p.personalBaseline, p.personal, "personal-hub");
  await assertOnlyStagingPathsChanged(
    meta,
    (path) => path.startsWith(`work-hub/presentations/launch-readiness/${current.runId}/`),
  );
  return `preserved two prior results and published revision ${current.runId}`;
}

async function cancelledAttention(meta: Metadata): Promise<string> {
  const p = paths(meta);
  const before = await projectData(p.workBaseline, "investigations", "supplier-risk");
  const after = await projectData(p.work, "investigations", "supplier-risk");
  const runId = requireValue(before.project.activeRun, "seeded supplier run is not active");
  assert(after.project.status === "active", "cancelled project was archived");
  assert(after.project.activeRun === null, "cancelled run remains active");
  assert(after.project.result === null && after.results.length === 0, "cancellation created a result");
  assert(runHistory(after.events, runId).state === "cancelled", "run lacks cancellation state");
  assert(
    committedTypes(after.events, before.events.at(-1)?.sequence ?? 0).join(",") === "run.cancelled",
    "cancellation appended unexpected committed events",
  );
  await assertOnlyPathsChanged(
    p.workBaseline,
    p.work,
    (path) =>
      path === "investigations/projects/supplier-risk/README.md"
      || path === "investigations/projects/supplier-risk/events.json",
  );
  await assertTreeUnchanged(p.personalBaseline, p.personal, "personal-hub");
  await assertStagingUnchanged(meta);
  return `cancelled only supplier-risk run ${runId}`;
}

async function restoredArchived(meta: Metadata): Promise<string> {
  const p = paths(meta);
  const before = await projectData(p.workBaseline, "presentations", "launch-readiness");
  const after = await projectData(p.work, "presentations", "launch-readiness");
  assert(after.project.status === "archived", "project was not archived again");
  assert(after.project.activeRun === null, "lifecycle operation created an active run");
  assert(after.results.length === before.results.length, "restore changed successful result count");
  assert(
    after.project.result === "runs/2026-06-01-001/result",
    `unexpected current result ${String(after.project.result)}`,
  );
  await assertPriorResultsUnchanged(before, after);
  assert(
    committedTypes(after.events, before.events.at(-1)?.sequence ?? 0).join(",")
      === "project.unarchived,result.restored,project.archived",
    "restore/archive lifecycle events are incomplete or out of order",
  );
  await assertOnlyPathsChanged(
    p.workBaseline,
    p.work,
    (path) =>
      path === "presentations/projects/launch-readiness/README.md"
      || path === "presentations/projects/launch-readiness/events.json",
  );
  await assertTreeUnchanged(p.personalBaseline, p.personal, "personal-hub");
  await assertStagingUnchanged(meta);
  return "restored 2026-06-01-001 and archived without modifying results";
}

async function concurrentRunRejected(meta: Metadata): Promise<string> {
  const p = paths(meta);
  await assertTreeUnchanged(p.workBaseline, p.work, "work-hub");
  await assertTreeUnchanged(p.personalBaseline, p.personal, "personal-hub");
  await assertStagingUnchanged(meta);
  await assertOriginUnchanged(meta);
  const data = await projectData(p.work, "investigations", "supplier-risk");
  assert(data.project.activeRun === "2026-06-25-001", "active run changed");
  assert(runHistory(data.events, data.project.activeRun).state === "paused", "paused run state changed");
  assert(
    committedTypes(data.events).filter((type) => type === "run.started").length === 1,
    "a second run was started",
  );
  const finalMessage = requireValue(meta.finalMessage, "missing final response");
  assertPatterns(finalMessage, [
    /active (?:paused )?run|already has an active run|prevents concurrent runs|only one run can be active/iu,
    /resume|cancel/iu,
  ], "guardrail response");
  return "rejected a concurrent run without changing either hub";
}

async function ambiguousReadOnly(meta: Metadata): Promise<string> {
  const p = paths(meta);
  await assertTreeUnchanged(p.workBaseline, p.work, "work-hub");
  await assertTreeUnchanged(p.personalBaseline, p.personal, "personal-hub");
  await assertStagingUnchanged(meta);
  await assertOriginUnchanged(meta);
  const first = requireValue(meta.turns?.[0]?.finalMessage, "missing discovery response");
  assertPatterns(first, [
    /multiple|both|two|which|ambig/iu,
    /work-hub/iu,
    /personal-hub/iu,
  ], "ambiguity response");
  assert(first.includes("?"), "ambiguity response did not ask the user to choose");
  const finalMessage = requireValue(meta.finalMessage, "missing selected result summary");
  assertPatterns(finalMessage, [/green/iu, /release train/iu], "selected result summary");
  assert(!/writing habit|weekly drafts/iu.test(finalMessage), "response summarized the wrong project");
  return "disambiguated duplicate project IDs and read the selected result without mutation";
}

/** Validate durable workspace state for one approved end-to-end scenario. */
export default async function workspaceState(_output: string, context: Ctx): Promise<Result> {
  const mode = context.config?.mode;
  const meta = context.providerResponse?.metadata;
  if (!mode) return fail("config.mode is required");
  if (!meta) return fail("provider metadata is required");
  try {
    const reason = mode === "completed-presentation"
      ? await completedPresentation(meta)
      : mode === "guided-investigation"
        ? await guidedInvestigation(meta)
        : mode === "revised-presentation"
          ? await revisedPresentation(meta)
          : mode === "cancelled-attention"
            ? await cancelledAttention(meta)
            : mode === "restored-archived"
              ? await restoredArchived(meta)
              : mode === "concurrent-run-rejected"
                ? await concurrentRunRejected(meta)
                : await ambiguousReadOnly(meta);
    return { pass: true, score: 1, reason };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
