import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { OkhError } from "../errors.js";
import { atomicWrite, readSafeTextFile } from "./files.js";
import type {
  CriterionEvidence,
  GuidanceRecord,
  ResultFile,
  ResultRecord,
  RunCheckpoint,
  RunReportState,
  WorkspaceEvent,
  WorkspaceMutationResult,
} from "./types.js";

export const MAX_EVENT_FILE_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEvent(value: unknown, expectedSequence: number): WorkspaceEvent {
  if (!isRecord(value)) {
    throw new OkhError("INVALID_MANIFEST", "events.json must contain event objects.");
  }
  if (
    value.specversion !== "1.0"
    || typeof value.id !== "string"
    || typeof value.source !== "string"
    || typeof value.type !== "string"
    || typeof value.time !== "string"
    || value.datacontenttype !== "application/json"
    || value.sequence !== expectedSequence
    || typeof value.okhcommandid !== "string"
    || !isRecord(value.data)
  ) {
    throw new OkhError(
      "INVALID_MANIFEST",
      `events.json event ${expectedSequence} does not match the workspace event contract.`,
    );
  }
  return value as unknown as WorkspaceEvent;
}

export async function readEvents(path: string, root = dirname(path)): Promise<WorkspaceEvent[]> {
  let raw: string;
  try {
    raw = await readSafeTextFile(root, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_EVENT_FILE_BYTES) {
    throw new OkhError("INVALID_MANIFEST", `${path} exceeds the workspace event-file limit.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OkhError("INVALID_MANIFEST", `${path} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new OkhError("INVALID_MANIFEST", `${path} must contain a JSON array.`);
  }
  return parsed.map((event, index) => validateEvent(event, index + 1));
}

export interface NewWorkspaceEvent {
  source: string;
  type: string;
  subject?: string;
  time: string;
  commandId: string;
  data: Record<string, unknown>;
}

export async function appendEvents(
  path: string,
  additions: readonly NewWorkspaceEvent[],
  root = dirname(path),
): Promise<WorkspaceEvent[]> {
  let raw: string | undefined;
  try {
    raw = await readSafeTextFile(root, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const existing = raw === undefined ? [] : await readEvents(path, root);
  const appended = additions.map((addition, index): WorkspaceEvent => ({
    specversion: "1.0",
    id: randomUUID(),
    source: addition.source,
    type: addition.type,
    ...(addition.subject ? { subject: addition.subject } : {}),
    time: addition.time,
    datacontenttype: "application/json",
    sequence: existing.length + index + 1,
    okhcommandid: addition.commandId,
    data: addition.data,
  }));
  const rendered = appended
    .map((event) => JSON.stringify(event, null, 2).replace(/^/gmu, "  "))
    .join(",\n");
  let content: string;
  if (raw === undefined || existing.length === 0) {
    content = `[\n${rendered}\n]\n`;
  } else {
    const closing = raw.lastIndexOf("]");
    let insertion = closing - 1;
    while (insertion >= 0 && /\s/u.test(raw[insertion]!)) insertion -= 1;
    if (closing < 0 || raw[insertion] !== "}") {
      throw new OkhError("INVALID_MANIFEST", `${path} has an invalid JSON batch boundary.`);
    }
    content = `${raw.slice(0, insertion + 1)},\n${rendered}${raw.slice(insertion + 1)}`;
  }
  if (Buffer.byteLength(content, "utf8") > MAX_EVENT_FILE_BYTES) {
    throw new OkhError("CONFLICT", "The workspace event file has reached its size limit.");
  }
  await atomicWrite(path, content, root);
  return appended;
}

export interface CommandReplay {
  kind: "none" | "prepared" | "committed";
  prepared?: WorkspaceEvent;
  outcome?: WorkspaceMutationResult;
}

export function commandReplay(
  events: readonly WorkspaceEvent[],
  commandId: string,
  argumentHash: string,
): CommandReplay {
  const matching = events.filter((event) => event.okhcommandid === commandId);
  if (matching.length === 0) return { kind: "none" };
  for (const event of matching) {
    if (event.data.argumentHash !== argumentHash) {
      throw new OkhError(
        "CONFLICT",
        `commandId "${commandId}" was already used with different arguments.`,
      );
    }

  }
  const committed = [...matching].reverse().find((event) => event.type.endsWith(".committed"));
  if (committed) {
    const outcome = committed.data.outcome;
    if (!isRecord(outcome)) {
      throw new OkhError("INVALID_MANIFEST", "Committed workspace event has no recorded outcome.");
    }
    return {
      kind: "committed",
      outcome: { ...(outcome as unknown as WorkspaceMutationResult), replayed: true },
    };
  }
  if (matching.at(-1)?.type.endsWith(".aborted")) {
    return {
      kind: "none",
      prepared: [...matching].reverse().find((event) => event.type.endsWith(".prepared")),
    };
  }
  const prepared = [...matching].reverse().find((event) => event.type.endsWith(".prepared"));
  return prepared ? { kind: "prepared", prepared } : { kind: "none" };
}

export function pendingTransaction(events: readonly WorkspaceEvent[]): WorkspaceEvent | undefined {
  return events.find((event) => {
    if (!event.type.endsWith(".prepared")) return false;
    return !events.some(
      (candidate) =>
        candidate.okhcommandid === event.okhcommandid
        && candidate.sequence > event.sequence
        && (candidate.type.endsWith(".committed") || candidate.type.endsWith(".aborted")),
    );
  });
}

export interface RunHistory {
  state: "active" | RunReportState;
  checkpoint: RunCheckpoint | null;
  guidance: GuidanceRecord[];
  result: ResultRecord | null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function runHistory(events: readonly WorkspaceEvent[], runId: string): RunHistory {
  const subject = `runs/${runId}`;
  const relevant = events.filter((event) => event.subject === subject);
  let state: RunHistory["state"] = "active";
  let checkpoint: RunCheckpoint | null = null;
  const guidance: GuidanceRecord[] = [];
  let result: ResultRecord | null = null;
  for (const event of relevant) {
    if (event.type === "dev.okh.workspace.run.paused.committed") {
      state = "paused";
      const value = event.data.checkpoint;
      if (isRecord(value) && typeof value.summary === "string") {
        checkpoint = value as unknown as RunCheckpoint;
      }
    } else if (event.type === "dev.okh.workspace.run.guided.committed") {
      const text = stringValue(event.data.guidance);
      if (text) guidance.push({ time: event.time, text });
      if (state === "paused") state = "active";
    } else if (event.type === "dev.okh.workspace.run.succeeded.committed") {
      state = "succeeded";
      const files = Array.isArray(event.data.files) ? event.data.files as ResultFile[] : [];
      const evidence = Array.isArray(event.data.evidence)
        ? event.data.evidence as CriterionEvidence[]
        : [];
      const path = stringValue(event.data.resultPath);
      const treeHash = stringValue(event.data.treeHash);
      if (path && treeHash) {
        result = {
          runId,
          finishedAt: event.time,
          path,
          treeHash,
          files,
          evidence,
        };
      }
    } else if (event.type === "dev.okh.workspace.run.failed.committed") {
      state = "failed";
    } else if (event.type === "dev.okh.workspace.run.cancelled.committed") {
      state = "cancelled";
    }
  }
  return { state, checkpoint, guidance, result };
}

export function successfulResults(events: readonly WorkspaceEvent[]): ResultRecord[] {
  const runIds = new Set(
    events
      .filter((event) => event.type === "dev.okh.workspace.run.succeeded.committed")
      .map((event) => event.subject?.replace(/^runs\//u, ""))
      .filter((value): value is string => Boolean(value)),
  );
  return [...runIds]
    .map((runId) => runHistory(events, runId).result)
    .filter((result): result is ResultRecord => result !== null)
    .sort((left, right) =>
      left.finishedAt < right.finishedAt ? 1 : left.finishedAt > right.finishedAt ? -1 : 0);
}
