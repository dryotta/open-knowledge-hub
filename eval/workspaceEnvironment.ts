import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OkhPaths } from "../src/config.js";
import { ContainerService } from "../src/container/service.js";
import type { Runner } from "../src/exec.js";
import { Gh } from "../src/git/gh.js";
import { Git } from "../src/git/git.js";
import { WorkspaceService } from "../src/workspaces/service.js";
import type {
  CriterionEvidence,
  WorkspaceMutationResult,
} from "../src/workspaces/types.js";

const COMMAND_PREFIX = "70000000-0000-4000-8000-";

function command(index: number): string {
  return `${COMMAND_PREFIX}${String(index).padStart(12, "0")}`;
}

interface SeedClock {
  now: () => Date;
  set: (iso: string) => void;
}

function seedClock(): SeedClock {
  let base = Date.parse("2026-05-01T09:00:00.000Z");
  let tick = 0;
  return {
    now: () => new Date(base + tick++ * 1_000),
    set: (iso) => {
      base = Date.parse(iso);
      tick = 0;
    },
  };
}

function requireProject(result: WorkspaceMutationResult): NonNullable<WorkspaceMutationResult["project"]> {
  if (!result.project) throw new Error("workspace seed mutation did not return a project");
  return result.project;
}

function requireRun(result: WorkspaceMutationResult): NonNullable<WorkspaceMutationResult["resume"]> {
  if (!result.resume) throw new Error("workspace seed start did not return a resume package");
  return result.resume;
}

async function writeResult(
  start: WorkspaceMutationResult,
  files: Record<string, string>,
): Promise<void> {
  const resume = requireRun(start);
  await mkdir(resume.stagingPath, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const segments = path.split("/");
    const file = segments.pop();
    if (!file) throw new Error(`invalid seeded result path: ${path}`);
    const directory = segments.length > 0
      ? join(resume.stagingPath, ...segments)
      : resume.stagingPath;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, file), content, "utf8");
  }
}

function evidence(start: WorkspaceMutationResult, reference: string): CriterionEvidence[] {
  const criteria = requireRun(start).criteria;
  return criteria.map((criterion) => ({
    criterion: criterion.id,
    references: [reference],
  }));
}

async function initializeWorkspace(
  service: WorkspaceService,
  container: string,
  module: string,
  guidance: string,
  acceptance: string,
  commandIndex: number,
): Promise<void> {
  await service.create({
    operation: "create",
    container,
    module,
    guidance,
    acceptance: [acceptance],
    commandId: command(commandIndex),
  });
}

/**
 * Seed lifecycle-rich workspace state after the eval containers are registered.
 * The caller commits this state before Copilot starts, so it is a clean baseline.
 */
export async function seedWorkspaceEnvironment(
  paths: OkhPaths,
  runner: Runner,
): Promise<void> {
  const clock = seedClock();
  const containers = new ContainerService(
    paths,
    new Git(runner),
    new Gh(runner),
  );
  const service = new WorkspaceService(containers, paths, clock.now);
  let id = 1;

  await initializeWorkspace(
    service,
    "work-hub",
    "presentations",
    "Create decision-ready Markdown presentations from supplied facts and prior results. Qualitative analysis is allowed, but unsupported specifics are not. Strict source-bounded requests must not add years, quantities, examples, technologies, or implementation details.",
    "Every factual statement is supported by the brief or prior result; proposals add no fabricated sources, dates, metrics, costs, thresholds, quantities, named examples, or implementation details.",
    id++,
  );
  await initializeWorkspace(
    service,
    "work-hub",
    "investigations",
    "Compare credible options using supplied evidence, quantify only supported tradeoffs, and make uncertainty explicit.",
    "The recommendation states its evidence, uncertainty, risks, and tradeoffs without fabricating sources, dates, metrics, costs, or thresholds.",
    id++,
  );
  await initializeWorkspace(
    service,
    "personal-hub",
    "writing",
    "Draft concise personal writing without inventing facts.",
    "The result preserves the supplied meaning and identifies interpretation.",
    id++,
  );

  const launch = requireProject(await service.create({
    operation: "create",
    container: "work-hub",
    module: "presentations",
    project: "launch-readiness",
    title: "Launch readiness",
    goal: "Recommend whether the product is ready to launch.",
    guidance: "Keep the deck concise and decision-oriented.",
    targetDate: "2026-09-15",
    tags: ["launch"],
    commandId: command(id++),
  }));

  clock.set("2026-06-01T09:00:00.000Z");
  const launchFirst = await service.start({
    operation: "start",
    container: "work-hub",
    module: "presentations",
    project: "launch-readiness",
    etag: launch.etag,
    commandId: command(id++),
  });
  await writeResult(launchFirst, {
    "deck.md": [
      "# Launch readiness",
      "",
      "## Recommendation",
      "",
      "Delay launch until onboarding friction is reduced.",
      "",
      "## Evidence",
      "",
      "- Beta participation is promising, but setup remains a material blocker.",
      "",
      "## Source boundaries",
      "",
      "This result uses only the supplied project brief.",
      "",
    ].join("\n"),
  });
  const launchFirstReported = await service.report({
    operation: "report",
    container: "work-hub",
    module: "presentations",
    project: "launch-readiness",
    run: requireRun(launchFirst).runId,
    state: "succeeded",
    resultPath: ".",
    evidence: evidence(launchFirst, "deck.md#evidence"),
    etag: launchFirst.etag,
    commandId: command(id++),
  });

  clock.set("2026-06-15T09:00:00.000Z");
  const launchSecond = await service.start({
    operation: "start",
    container: "work-hub",
    module: "presentations",
    project: "launch-readiness",
    correction: "Clarify the onboarding decision and preserve the original result.",
    etag: launchFirstReported.etag,
    commandId: command(id++),
  });
  await writeResult(launchSecond, {
    "deck.md": [
      "# Launch readiness",
      "",
      "## Current recommendation",
      "",
      "Delay launch while onboarding remains the primary readiness risk.",
      "",
      "## Established facts",
      "",
      "- Launch target: September 15.",
      "- 42 beta teams; 36 are weekly active.",
      "- SSO setup averages three days and is the main blocker.",
      "",
      "## Decision",
      "",
      "Choose between guided onboarding and delaying launch.",
      "",
      "## Source boundaries",
      "",
      "This result uses only the supplied project brief and the prior immutable result.",
      "",
    ].join("\n"),
  });
  const launchSecondReported = await service.report({
    operation: "report",
    container: "work-hub",
    module: "presentations",
    project: "launch-readiness",
    run: requireRun(launchSecond).runId,
    state: "succeeded",
    resultPath: ".",
    evidence: evidence(launchSecond, "deck.md#established-facts"),
    etag: launchSecond.etag,
    commandId: command(id++),
  });
  await service.update({
    operation: "update",
    container: "work-hub",
    module: "presentations",
    project: "launch-readiness",
    action: "archive",
    etag: launchSecondReported.etag,
    commandId: command(id++),
  });

  clock.set("2026-06-20T09:00:00.000Z");
  const workQuarterly = requireProject(await service.create({
    operation: "create",
    container: "work-hub",
    module: "presentations",
    project: "quarterly-review",
    title: "Quarterly review",
    goal: "Summarize delivery health for the executive review.",
    tags: ["executive"],
    commandId: command(id++),
  }));
  const workQuarterlyStart = await service.start({
    operation: "start",
    container: "work-hub",
    module: "presentations",
    project: "quarterly-review",
    etag: workQuarterly.etag,
    commandId: command(id++),
  });
  await writeResult(workQuarterlyStart, {
    "summary.md": [
      "# Work quarterly review",
      "",
      "Delivery health is green. The release train met its commitments.",
      "",
      "## Source boundaries",
      "",
      "This summary uses only the supplied project brief.",
      "",
    ].join("\n"),
  });
  await service.report({
    operation: "report",
    container: "work-hub",
    module: "presentations",
    project: "quarterly-review",
    run: requireRun(workQuarterlyStart).runId,
    state: "succeeded",
    resultPath: ".",
    evidence: evidence(workQuarterlyStart, "summary.md"),
    etag: workQuarterlyStart.etag,
    commandId: command(id++),
  });

  clock.set("2026-06-21T09:00:00.000Z");
  const personalQuarterly = requireProject(await service.create({
    operation: "create",
    container: "personal-hub",
    module: "writing",
    project: "quarterly-review",
    title: "Quarterly review",
    goal: "Reflect on personal writing progress.",
    tags: ["reflection"],
    commandId: command(id++),
  }));
  const personalQuarterlyStart = await service.start({
    operation: "start",
    container: "personal-hub",
    module: "writing",
    project: "quarterly-review",
    etag: personalQuarterly.etag,
    commandId: command(id++),
  });
  await writeResult(personalQuarterlyStart, {
    "summary.md": [
      "# Personal quarterly review",
      "",
      "The writing habit improved through shorter weekly drafts.",
      "",
    ].join("\n"),
  });
  await service.report({
    operation: "report",
    container: "personal-hub",
    module: "writing",
    project: "quarterly-review",
    run: requireRun(personalQuarterlyStart).runId,
    state: "succeeded",
    resultPath: ".",
    evidence: evidence(personalQuarterlyStart, "summary.md"),
    etag: personalQuarterlyStart.etag,
    commandId: command(id++),
  });

  clock.set("2026-06-25T09:00:00.000Z");
  const supplier = requireProject(await service.create({
    operation: "create",
    container: "work-hub",
    module: "investigations",
    project: "supplier-risk",
    title: "Supplier risk",
    goal: "Recommend whether to retain the current supplier.",
    guidance: "Stop for a human decision before making the recommendation.",
    tags: ["sourcing"],
    commandId: command(id++),
  }));
  const supplierStart = await service.start({
    operation: "start",
    container: "work-hub",
    module: "investigations",
    project: "supplier-risk",
    etag: supplier.etag,
    commandId: command(id++),
  });
  await writeResult(supplierStart, {
    "draft.md": [
      "# Supplier risk draft",
      "",
      "Two viable suppliers remain. A decision-owner preference is still required.",
      "",
    ].join("\n"),
  });
  await service.report({
    operation: "report",
    container: "work-hub",
    module: "investigations",
    project: "supplier-risk",
    run: requireRun(supplierStart).runId,
    state: "paused",
    checkpoint: {
      summary: "The evidence is assembled; a decision-owner preference is required.",
      stagedPaths: ["draft.md"],
      question: "Should cost or supply resilience dominate the recommendation?",
      reason: "human-decision",
    },
    etag: supplierStart.etag,
    commandId: command(id++),
  });
}
