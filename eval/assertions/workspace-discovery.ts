import type { ToolEvent } from "../copilot.js";
import { isDeepSubset } from "./tool-events.js";

interface WorkspaceListExpectation {
  container: string;
  module: string;
  status?: string;
  attention?: boolean;
  query?: string;
  tags?: string[];
}

interface Ctx {
  config?: {
    containers?: string[];
    lists?: WorkspaceListExpectation[];
    selected?: { container: string; module: string };
  };
  providerResponse?: {
    metadata?: {
      toolEvents?: ToolEvent[];
      containerPaths?: Record<string, string>;
    };
  };
}

interface Result {
  pass: boolean;
  score: number;
  reason: string;
}

const fail = (reason: string): Result => ({ pass: false, score: 0, reason });

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function successful(event: ToolEvent, tool: string): boolean {
  return event.server === "open-knowledge-hub"
    && event.tool === tool
    && event.completed
    && event.success;
}

/** Prove that an unspecified workspace was discovered across containers before selection. */
export default function workspaceDiscovery(_output: string, context: Ctx): Result {
  const events = context.providerResponse?.metadata?.toolEvents ?? [];
  const containerPaths = context.providerResponse?.metadata?.containerPaths ?? {};
  const containers = context.config?.containers ?? [];
  const lists = context.config?.lists ?? [];
  const selected = context.config?.selected;

  const rootInspectIndex = events.findIndex((event) => {
    if (!successful(event, "inspect")) return false;
    const args = asRecord(event.arguments);
    return args !== undefined && Object.keys(args).length === 0;
  });
  if (rootInspectIndex < 0) return fail("no successful root inspect call discovered registered containers");
  const rootInspect = events[rootInspectIndex]!;

  for (const container of containers) {
    if (!containerPaths[container]) return fail(`discovery fixture lacks container ${container}`);
    if (!rootInspect.result?.includes(container)) {
      return fail(`root inspect response did not expose container ${container}`);
    }
  }

  const rootCompletion = rootInspect.completionSequence;
  if (rootCompletion === undefined) return fail("root inspect lacks completion sequence");

  const allListEvents = events.filter((event) => {
    if (event.server !== "open-knowledge-hub" || event.tool !== "workspace") return false;
    return asRecord(event.arguments)?.operation === "list";
  });
  for (const event of allListEvents) {
    if (event.startSequence === undefined) {
      return fail(`workspace list search ${event.callId} lacks a start sequence`);
    }
    if (event.startSequence <= rootCompletion) {
      return fail(`workspace list search ${event.callId} started before root discovery completed`);
    }
    if (event.completionSequence === undefined) {
      return fail(`workspace list search ${event.callId} lacks a completion sequence`);
    }
  }

  for (const expected of lists) {
    const found = allListEvents.find((event) =>
      successful(event, "workspace")
      && isDeepSubset(event.arguments, { operation: "list", ...expected }));
    if (!found) {
      return fail(`workspace list search missing for ${expected.container}/${expected.module}`);
    }
    if (found.completionSequence === undefined) {
      return fail(`workspace list search lacks completion sequence for ${expected.container}/${expected.module}`);
    }
  }

  if (selected) {
    const discoveryBoundary = Math.max(
      rootCompletion,
      ...allListEvents.map((event) => event.completionSequence!),
    );
    const selectedEvent = events.find((event) => {
      if (
        event.startSequence === undefined
        || event.startSequence <= discoveryBoundary
        || !successful(event, "workspace")
      ) return false;
      const args = asRecord(event.arguments);
      return args?.operation !== "list" && isDeepSubset(args, selected);
    });
    if (!selectedEvent) {
      return fail(`no selected workspace operation followed complete discovery for ${selected.container}/${selected.module}`);
    }

    const prematureSelection = events.find((event) => {
      if (
        event.server !== "open-knowledge-hub"
        || event.tool !== "workspace"
        || event.startSequence === undefined
        || event.startSequence > discoveryBoundary
      ) return false;
      const args = asRecord(event.arguments);
      return args?.operation !== "list" && isDeepSubset(args, selected);
    });
    if (prematureSelection) {
      return fail(`workspace selection ${prematureSelection.callId} occurred before discovery completed`);
    }

    const mutations = events.filter((event) => {
      if (event.server !== "open-knowledge-hub" || event.tool !== "workspace") return false;
      const operation = asRecord(event.arguments)?.operation;
      return ["create", "start", "report", "update", "intervene"].includes(String(operation));
    });
    const wrong = mutations.find((event) =>
      !isDeepSubset(event.arguments, selected));
    if (wrong) {
      const args = asRecord(wrong.arguments);
      return fail(
        `mutation targeted ${String(args?.container)}/${String(args?.module)} instead of ${selected.container}/${selected.module}`,
      );
    }
    const premature = events.find((event) => {
      if (
        event.server !== "open-knowledge-hub"
        || event.tool !== "workspace"
        || event.startSequence === undefined
        || event.startSequence > discoveryBoundary
      ) return false;
      const operation = asRecord(event.arguments)?.operation;
      return ["create", "start", "report", "update", "intervene"].includes(String(operation));
    });
    if (premature) return fail(`workspace mutation ${premature.callId} occurred before discovery completed`);
  }

  return {
    pass: true,
    score: 1,
    reason: `discovered ${containers.length} container(s) and ${lists.length} workspace search(es)`,
  };
}
