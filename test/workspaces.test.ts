import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Gh } from "../src/git/gh.js";
import { Git } from "../src/git/git.js";
import { ContainerService } from "../src/container/service.js";
import { OkhError } from "../src/errors.js";
import { workspaceLoader } from "../src/modules/loaders/workspace.js";
import {
  appendEvents,
  pendingTransaction,
  readEvents,
} from "../src/workspaces/events.js";
import {
  canonicalJson,
  inspectResultTree,
  publishResult,
  sha256,
  workspaceStagingRoot,
} from "../src/workspaces/files.js";
import {
  createProjectReadme,
  parseProjectReadme,
  patchProjectReadme,
} from "../src/workspaces/markdown.js";
import { WorkspaceService } from "../src/workspaces/service.js";
import type {
  WorkspaceStartInput,
} from "../src/workspaces/types.js";
import {
  makePaths,
  makeTempDir,
  testRun,
  writeModule,
} from "./helpers.js";

class FakeGh {
  async currentLogin(): Promise<string> { return "tester"; }
  async createRepo(): Promise<string> { return "x"; }
  async createPr(): Promise<string> { return "x"; }
}

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function command(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function setup() {
  const home = await makeTempDir("okh-workspace-home-");
  const root = await makeTempDir("okh-workspace-container-");
  cleanups.push(home, root);
  const paths = makePaths(home);
  const containers = new ContainerService(
    paths,
    new Git(testRun),
    new FakeGh() as unknown as Gh,
  );
  await containers.addContainer({ source: root, name: "work", create: true });
  await writeModule(root, "agents", {
    type: "agents",
    description: "Workspace agents",
  });
  const agentRoot = join(root, "agents", ".github", "agents");
  await mkdir(agentRoot, { recursive: true });
  await writeFile(
    join(agentRoot, "lead.agent.md"),
    "---\ndescription: Plans and integrates work\ntools: [read, search]\n---\n\nLead the project.\n",
    "utf8",
  );
  await writeFile(
    join(agentRoot, "researcher.agent.md"),
    "---\ndescription: Finds primary evidence\ntools: [read, web]\n---\n\nResearch the assigned question.\n",
    "utf8",
  );
  await writeModule(root, "investigations", {
    type: "workspace",
    description: "Investigate evidence-based questions.",
    config: {
      lead: "agents/lead",
      agents: ["agents/researcher"],
    },
  });
  await workspaceLoader.scaffold!(join(root, "investigations"));
  let tick = Date.parse("2026-07-19T18:30:00.000Z");
  const service = new WorkspaceService(containers, paths, () => {
    tick += 1_000;
    return new Date(tick);
  });
  await service.create({
    operation: "create",
    container: "work",
    module: "investigations",
    guidance: "Prefer primary evidence.",
    acceptance: ["Material claims cite primary sources."],
    commandId: command(1),
  });
  const created = await service.create({
    operation: "create",
    container: "work",
    module: "investigations",
    project: "supplier-risk",
    title: "Supplier risk",
    goal: "Recommend resilient alternatives.",
    acceptance: ["Cover both operating regions."],
    tags: ["Strategy", "sourcing"],
    commandId: command(2),
  });
  return {
    root,
    paths,
    containers,
    service,
    project: created.project!,
  };
}

describe("workspace Markdown", () => {
  it("patches known fields and case-insensitive CRLF sections without replacing custom content", () => {
    const initial = createProjectReadme({
      title: "Original",
      goal: "Original goal",
      guidance: "Old guidance",
      acceptance: ["Keep evidence"],
      createdAt: "2026-07-19T18:30:00.000Z",
    })
      .replace("## Guidance", "## gUiDaNcE")
      .replace(/\n/gu, "\r\n")
      .concat("\r\n## Notes\r\n\r\nKeep this custom section verbatim.\r\n");
    const project = parseProjectReadme("example", initial, "sha256:old");

    const patched = patchProjectReadme(project, {
      title: "Revised",
      goal: "Revised goal",
      guidance: null,
      targetDate: "2026-08-15",
      tags: ["Risk", "risk"],
      updatedAt: "2026-07-19T19:00:00.000Z",
    });
    const parsed = parseProjectReadme("example", patched, "sha256:new");

    expect(parsed).toMatchObject({
      title: "Revised",
      goal: "Revised goal",
      targetDate: "2026-08-15",
      tags: ["risk"],
    });
    expect(parsed.guidance).toBeUndefined();
    expect(patched).not.toMatch(/## gUiDaNcE/iu);
    expect(patched).toContain("## Notes\r\n\r\nKeep this custom section verbatim.");
  });
});

describe("workspace event journal", () => {
  it("keeps prior event bytes while appending contiguous CloudEvents", async () => {
    const root = await makeTempDir("okh-workspace-events-");
    cleanups.push(root);
    const path = join(root, "events.json");
    const base = {
      source: "okh://work/investigations/projects/example",
      subject: "runs/2026-07-19-001",
      time: "2026-07-19T18:30:00.000Z",
      data: { argumentHash: "sha256:first", outcome: { etag: "sha256:first" } },
    };
    await appendEvents(path, [{
      ...base,
      type: "dev.okh.workspace.run.started.committed",
      commandId: command(10),
    }]);
    const first = await readFile(path, "utf8");
    const firstObject = first.slice(first.indexOf("{"), first.lastIndexOf("}") + 1);

    await appendEvents(path, [{
      ...base,
      type: "dev.okh.workspace.run.paused.committed",
      commandId: command(11),
      data: { argumentHash: "sha256:second", outcome: { etag: "sha256:second" } },
    }]);

    const second = await readFile(path, "utf8");
    expect(second).toContain(firstObject);
    expect((await readEvents(path)).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("tracks the latest retry as pending after an earlier attempt was aborted", async () => {
    const root = await makeTempDir("okh-workspace-pending-");
    cleanups.push(root);
    const path = join(root, "events.json");
    const base = {
      source: "okh://work/investigations/projects/example",
      subject: "runs/2026-07-19-001",
      time: "2026-07-19T18:30:00.000Z",
      commandId: command(14),
      data: { argumentHash: "sha256:retry", outcome: { etag: "sha256:target" } },
    };
    await appendEvents(path, [
      { ...base, type: "dev.okh.workspace.run.started.prepared" },
      { ...base, type: "dev.okh.workspace.run.started.aborted" },
      { ...base, type: "dev.okh.workspace.run.started.prepared" },
    ]);
    const retried = await readEvents(path);
    expect(pendingTransaction(retried)?.sequence).toBe(3);

    await appendEvents(path, [{
      ...base,
      type: "dev.okh.workspace.run.started.committed",
    }]);
    expect(pendingTransaction(await readEvents(path))).toBeUndefined();
  });

  describe("workspace result files", () => {
    it("uses canonical metadata and refuses bytes that changed after inspection", async () => {
      const root = await makeTempDir("okh-workspace-result-");
      cleanups.push(root);
      const source = join(root, "source");
      const destination = join(root, "published");
      await mkdir(source);
      await mkdir(join(source, "a"));
      await writeFile(join(source, "b.txt"), "b", "utf8");
      await writeFile(join(source, "a.txt"), "a", "utf8");
      await writeFile(join(source, "a", "z.txt"), "z", "utf8");

      const inspected = await inspectResultTree(source, root);
      expect(inspected.files.map((file) => file.path)).toEqual(["a.txt", "a/z.txt", "b.txt"]);
      expect(inspected.treeHash).toBe(sha256(canonicalJson(inspected.files)));

      await writeFile(join(source, "a.txt"), "changed", "utf8");
      await expect(publishResult(source, destination, inspected, root, root))
        .rejects.toMatchObject<Partial<OkhError>>({ code: "CONFLICT" });
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

describe("workspace loader", () => {
  it("scaffolds projects and enumerates valid project READMEs", async () => {
    const { root } = await setup();
    const moduleRoot = join(root, "investigations");

    const items = await workspaceLoader.enumerate(moduleRoot);
    const issues = await workspaceLoader.validate!(moduleRoot);

    expect(items).toEqual([expect.objectContaining({
      path: "projects/supplier-risk/README.md",
      title: "Supplier risk",
      type: "project",
    })]);
    expect(issues).toEqual([]);
  });
});

describe("WorkspaceService lifecycle", () => {
  it("replays workspace initialization and updates from durable command records", async () => {
    const { service } = await setup();
    const initializedReplay = await service.create({
      operation: "create",
      container: "work",
      module: "investigations",
      guidance: "Prefer primary evidence.",
      acceptance: ["Material claims cite primary sources."],
      commandId: command(1),
    });
    expect(initializedReplay.replayed).toBe(true);
    expect(initializedReplay.counts).toMatchObject({ active: 0, archived: 0 });

    const workspace = await service.get({
      operation: "get",
      container: "work",
      module: "investigations",
    });
    const firstInput = {
      operation: "update" as const,
      container: "work",
      module: "investigations",
      patch: { guidance: "First guidance." },
      etag: workspace.etag,
      commandId: command(12),
    };
    const first = await service.update(firstInput);
    const second = await service.update({
      operation: "update",
      container: "work",
      module: "investigations",
      patch: { guidance: "Second guidance." },
      etag: first.etag,
      commandId: command(13),
    });
    expect(second.workspace?.guidance).toBe("Second guidance.");

    const replay = await service.update(firstInput);
    expect(replay).toMatchObject({
      replayed: true,
      etag: first.etag,
      workspace: { guidance: "First guidance." },
    });
    await expect(service.update({
      ...firstInput,
      patch: { guidance: "Different arguments." },
    })).rejects.toMatchObject<Partial<OkhError>>({ code: "CONFLICT" });
  });

  it("starts, pauses, guides, resumes, succeeds, and replays the terminal report", async () => {
    const { root, service, project } = await setup();
    const startInput: WorkspaceStartInput = {
      operation: "start",
      container: "work",
      module: "investigations",
      project: project.id,
      etag: project.etag,
      commandId: command(20),
    };
    const started = await service.start(startInput);
    expect(started.project?.activeRun).toBe("2026-07-19-001");
    expect(started.resume?.criteria.map((criterion) => criterion.id)).toEqual([
      "workspace-1",
      "project-1",
    ]);
    expect(started.resume?.profiles.lead.agent.id).toBe("lead");
    expect(started.resume?.profiles.pool.map((profile) => profile.agent.id)).toEqual(["researcher"]);

    const paused = await service.report({
      operation: "report",
      container: "work",
      module: "investigations",
      project: project.id,
      run: started.resume!.runId,
      state: "paused",
      checkpoint: {
        summary: "A source needs interpretation.",
        question: "Should the reporting lag be accepted?",
      },
      etag: started.etag,
      commandId: command(21),
    });
    const attention = await service.list({
      operation: "list",
      container: "work",
      module: "investigations",
      attention: true,
    });
    expect(attention.projects).toEqual([
      expect.objectContaining({
        id: project.id,
        attention: expect.objectContaining({ kind: "paused" }),
      }),
    ]);

    const guided = await service.intervene({
      operation: "intervene",
      container: "work",
      module: "investigations",
      project: project.id,
      run: started.resume!.runId,
      action: "guide",
      guidance: "Accept the lag and label it.",
      etag: paused.etag,
      commandId: command(22),
    });
    const resumed = await service.get({
      operation: "get",
      container: "work",
      module: "investigations",
      project: project.id,
      include: ["resume"],
    });
    expect(resumed.resume?.guidance.at(-1)?.text).toBe("Accept the lag and label it.");
    expect((await service.list({
      operation: "list",
      container: "work",
      module: "investigations",
      attention: true,
    })).projects).toEqual([]);

    await writeFile(join(started.resume!.stagingPath, "report.md"), "# Result\n\nEvidence.\n", "utf8");
    const reportInput = {
      operation: "report" as const,
      container: "work",
      module: "investigations",
      project: project.id,
      run: started.resume!.runId,
      state: "succeeded" as const,
      resultPath: ".",
      evidence: [
        { criterion: "workspace-1", references: ["report.md#evidence"] },
        { criterion: "project-1", references: ["report.md#evidence"] },
      ],
      etag: guided.etag,
      commandId: command(23),
    };
    const succeeded = await service.report(reportInput);
    expect(succeeded.project).toMatchObject({
      activeRun: null,
      result: "runs/2026-07-19-001/result",
      status: "active",
    });
    expect(await readFile(
      join(root, "investigations", "projects", project.id, "runs", "2026-07-19-001", "result", "report.md"),
      "utf8",
    )).toContain("Evidence");

    const replay = await service.report(reportInput);
    expect(replay.replayed).toBe(true);
    expect(replay.etag).toBe(succeeded.etag);
  });

  it("freezes active-run profiles and recovers a prepared start without live agents", async () => {
    const { root, service, project } = await setup();
    const input: WorkspaceStartInput = {
      operation: "start",
      container: "work",
      module: "investigations",
      project: project.id,
      etag: project.etag,
      commandId: command(30),
    };
    const started = await service.start(input);
    const eventsPath = join(
      root,
      "investigations",
      "projects",
      project.id,
      "events.json",
    );
    const events = await readEvents(eventsPath);
    expect(events.at(-1)?.type).toBe("dev.okh.workspace.run.started.committed");
    await writeFile(eventsPath, `${JSON.stringify(events.slice(0, -1), null, 2)}\n`, "utf8");
    await rm(join(root, "agents", ".github", "agents"), { recursive: true, force: true });

    const recovered = await service.start(input);
    expect(recovered.replayed).toBe(true);
    expect(recovered.resume?.profiles.lead.profile.content).toContain("Lead the project.");

    const resumed = await service.get({
      operation: "get",
      container: "work",
      module: "investigations",
      project: project.id,
      include: ["resume"],
    });
    expect(resumed.resume?.profiles.pool[0]?.profile.content).toContain("Research the assigned question.");
    expect(resumed.etag).toBe(started.etag);
  });

  it("aborts failed result publication and retries the same command safely", async () => {
    const { root, service, project } = await setup();
    const started = await service.start({
      operation: "start",
      container: "work",
      module: "investigations",
      project: project.id,
      etag: project.etag,
      commandId: command(35),
    });
    await writeFile(join(started.resume!.stagingPath, "report.md"), "Expected\n", "utf8");
    const destination = join(
      root,
      "investigations",
      "projects",
      project.id,
      "runs",
      started.resume!.runId,
      "result",
    );
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "report.md"), "Conflicting\n", "utf8");
    const input = {
      operation: "report" as const,
      container: "work",
      module: "investigations",
      project: project.id,
      run: started.resume!.runId,
      state: "succeeded" as const,
      resultPath: ".",
      evidence: [
        { criterion: "workspace-1", references: ["report.md"] },
        { criterion: "project-1", references: ["report.md"] },
      ],
      etag: started.etag,
      commandId: command(36),
    };
    await expect(service.report(input)).rejects.toMatchObject<Partial<OkhError>>({
      code: "CONFLICT",
    });
    const eventsPath = join(root, "investigations", "projects", project.id, "events.json");
    expect((await readEvents(eventsPath)).at(-1)?.type).toBe(
      "dev.okh.workspace.run.succeeded.aborted",
    );

    await rm(destination, { recursive: true });
    const retried = await service.report(input);
    expect(retried.project?.result).toBe(`runs/${started.resume!.runId}/result`);
    expect(await readFile(join(destination, "report.md"), "utf8")).toBe("Expected\n");
  });

  it("keeps archived projects frozen and restores only intact successful results", async () => {
    const { service, project } = await setup();
    const archived = await service.update({
      operation: "update",
      container: "work",
      module: "investigations",
      project: project.id,
      action: "archive",
      etag: project.etag,
      commandId: command(40),
    });
    await expect(service.update({
      operation: "update",
      container: "work",
      module: "investigations",
      project: project.id,
      patch: { title: "Changed while archived" },
      etag: archived.etag,
      commandId: command(41),
    })).rejects.toMatchObject<Partial<OkhError>>({ code: "CONFLICT" });
    const active = await service.update({
      operation: "update",
      container: "work",
      module: "investigations",
      project: project.id,
      action: "unarchive",
      etag: archived.etag,
      commandId: command(42),
    });
    expect(active.project?.status).toBe("active");
  });

  it("rejects incomplete evidence and unsafe command identifiers without mutation", async () => {
    const { service, project } = await setup();
    await expect(service.start({
      operation: "start",
      container: "work",
      module: "investigations",
      project: project.id,
      etag: project.etag,
      commandId: "../unsafe",
    })).rejects.toMatchObject<Partial<OkhError>>({ code: "INVALID_ARGUMENT" });

    const started = await service.start({
      operation: "start",
      container: "work",
      module: "investigations",
      project: project.id,
      etag: project.etag,
      commandId: command(50),
    });
    await expect(service.report({
      operation: "report",
      container: "work",
      module: "investigations",
      project: project.id,
      run: started.resume!.runId,
      state: "paused",
      checkpoint: { summary: "Wait." },
      reason: "Not valid for paused.",
      etag: started.etag,
      commandId: command(51),
    })).rejects.toMatchObject<Partial<OkhError>>({ code: "INVALID_ARGUMENT" });
    await expect(service.intervene({
      operation: "intervene",
      container: "work",
      module: "investigations",
      project: project.id,
      run: started.resume!.runId,
      action: "cancel",
      guidance: "Not valid for cancel.",
      etag: started.etag,
      commandId: command(52),
    })).rejects.toMatchObject<Partial<OkhError>>({ code: "INVALID_ARGUMENT" });
    await writeFile(join(started.resume!.stagingPath, "result.md"), "Result\n", "utf8");
    await expect(service.report({
      operation: "report",
      container: "work",
      module: "investigations",
      project: project.id,
      run: started.resume!.runId,
      state: "succeeded",
      resultPath: ".",
      evidence: [{ criterion: "workspace-1", references: ["result.md"] }],
      etag: started.etag,
      commandId: command(53),
    })).rejects.toMatchObject<Partial<OkhError>>({ code: "INVALID_ARGUMENT" });
    const current = await service.get({
      operation: "get",
      container: "work",
      module: "investigations",
      project: project.id,
    });
    expect(current.project?.activeRun).toBe(started.resume!.runId);
  });

  it("rejects project junctions that resolve outside the workspace", async () => {
    const { root, service } = await setup();
    const external = await makeTempDir("okh-workspace-external-");
    cleanups.push(external);
    await writeFile(join(external, "README.md"), "# External\n", "utf8");
    const link = join(root, "investigations", "projects", "escaped");
    await symlink(external, link, process.platform === "win32" ? "junction" : "dir");
    try {
      await expect(service.get({
        operation: "get",
        container: "work",
        module: "investigations",
        project: "escaped",
      })).rejects.toMatchObject<Partial<OkhError>>({ code: "INVALID_MANIFEST" });
    } finally {
      await unlink(link);
    }
  });

  it("aborts a prepared start when staging is unsafe and allows an exact retry", async () => {
    const { root, paths, service, project } = await setup();
    const external = await makeTempDir("okh-workspace-staging-external-");
    cleanups.push(external);
    await writeFile(join(external, "sentinel.txt"), "keep\n", "utf8");
    const stagingRoot = workspaceStagingRoot(paths);
    await symlink(external, stagingRoot, process.platform === "win32" ? "junction" : "dir");
    const input: WorkspaceStartInput = {
      operation: "start",
      container: "work",
      module: "investigations",
      project: project.id,
      etag: project.etag,
      commandId: command(70),
    };
    try {
      await expect(service.start(input)).rejects.toMatchObject<Partial<OkhError>>({
        code: "INVALID_MANIFEST",
      });
      const eventsPath = join(
        root,
        "investigations",
        "projects",
        project.id,
        "events.json",
      );
      expect((await readEvents(eventsPath)).at(-1)?.type).toBe(
        "dev.okh.workspace.run.started.aborted",
      );
      expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe("keep\n");
    } finally {
      await unlink(stagingRoot);
    }

    const retried = await service.start(input);
    expect(retried.project?.activeRun).toBe("2026-07-19-001");
  });
});
