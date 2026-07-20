import type { ToolEvent } from "../copilot.js";

interface Ctx {
  providerResponse?: { metadata?: { toolEvents?: ToolEvent[] } };
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

function returnedUris(result: string | undefined): Set<string> {
  const matches = result?.match(/okh:\/\/[^\s"'<>]+/gu) ?? [];
  return new Set(matches.map((uri) => uri.replace(/[),.;\]}]+$/u, "")));
}

/** Require every resource read to use an exact URI returned by an earlier workspace call. */
export default function workspaceResourceReads(_output: string, context: Ctx): Result {
  const events = context.providerResponse?.metadata?.toolEvents ?? [];
  const reads = events
    .filter((event) => event.tool === "read_resource");
  if (reads.length === 0) return fail("no resource read was attempted");

  for (const event of reads) {
    const uri = asRecord(event.arguments)?.uri;
    if (typeof uri !== "string" || uri.length === 0) {
      return fail(`resource read ${event.callId} lacks a URI`);
    }
    if (!event.completed || !event.success) {
      return fail(`resource read ${event.callId} did not complete successfully`);
    }
    if (event.startSequence === undefined) {
      return fail(`resource read ${event.callId} lacks a start sequence`);
    }
    const returned = events.some((candidate) => {
      if (
        candidate.server !== "open-knowledge-hub"
        || candidate.tool !== "workspace"
        || !candidate.completed
        || !candidate.success
        || candidate.completionSequence === undefined
        || candidate.completionSequence >= event.startSequence!
      ) return false;
      const operation = asRecord(candidate.arguments)?.operation;
      return (operation === "get" || operation === "start")
        && returnedUris(candidate.result).has(uri);
    });
    if (!returned) {
      return fail(`resource read ${event.callId} used a URI not returned by an earlier workspace get/start`);
    }
  }

  return {
    pass: true,
    score: 1,
    reason: `${reads.length} resource read(s) used exact returned workspace URIs`,
  };
}
