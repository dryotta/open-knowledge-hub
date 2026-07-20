import type { ToolEvent } from "../copilot.js";
import { canonicalJson } from "../../src/workspaces/files.js";

interface Ctx {
  providerResponse?: { metadata?: { toolEvents?: ToolEvent[] } };
}

interface Result {
  pass: boolean;
  score: number;
  reason: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;
const ETAG_RE = /^sha256:[0-9a-f]{64}$/u;
const MUTATIONS = new Set(["create", "start", "report", "update", "intervene"]);
const ETAG_OPERATIONS = new Set(["start", "report", "update", "intervene"]);

const fail = (reason: string): Result => ({ pass: false, score: 0, reason });

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function generatorProduced(
  argumentsValue: unknown,
  result: string | undefined,
  commandId: string,
): boolean {
  const command = asRecord(argumentsValue)?.command;
  if (
    typeof command !== "string"
    || command.toLowerCase().includes(commandId.toLowerCase())
    || !/\[\s*(?:system\.)?guid\s*\]\s*::\s*newguid\s*\(|\bnew-guid\b|\brandomuuid\s*\(|\buuid\s*\.\s*uuid4\s*\(|\buuidgen\b/iu
      .test(command)
  ) return false;
  const outputIds = result?.match(UUID_TOKEN_RE) ?? [];
  return outputIds.some(
    (outputId) => outputId.toLowerCase() === commandId.toLowerCase(),
  );
}

/** Validate command IDs, ETags, success, and exact command-ID reuse for workspace mutations. */
export default function workspaceMutations(_output: string, context: Ctx): Result {
  const events = context.providerResponse?.metadata?.toolEvents ?? [];
  const mutations = events.filter((event) => {
    if (event.server !== "open-knowledge-hub" || event.tool !== "workspace") return false;
    const operation = asRecord(event.arguments)?.operation;
    return typeof operation === "string" && MUTATIONS.has(operation);
  });
  const seen = new Map<string, string>();

  for (const event of mutations) {
    const eventIndex = events.indexOf(event);
    const args = asRecord(event.arguments);
    if (!args) return fail("workspace mutation arguments must be an object");
    const operation = String(args.operation);
    if (!event.completed || !event.success) {
      return fail(`${operation} mutation ${event.callId} did not complete successfully`);
    }
    const commandId = args.commandId;
    if (typeof commandId !== "string" || !UUID_RE.test(commandId)) {
      return fail(`${operation} mutation ${event.callId} lacks an RFC 4122 commandId`);
    }
    if (!seen.has(commandId)) {
      const generated = events.slice(0, eventIndex).some((candidate) => {
        if (
          candidate.server !== ""
          || !candidate.completed
          || !candidate.success
        ) return false;
        return generatorProduced(candidate.arguments, candidate.result, commandId);
      });
      if (!generated) {
        return fail(`${operation} mutation ${event.callId} commandId was not produced by a captured UUID generator`);
      }
    }
    if (
      ETAG_OPERATIONS.has(operation)
      && (typeof args.etag !== "string" || !ETAG_RE.test(args.etag))
    ) {
      return fail(`${operation} mutation ${event.callId} lacks a SHA-256 ETag`);
    }

    const serialized = canonicalJson(args);
    const previous = seen.get(commandId);
    if (previous !== undefined && previous !== serialized) {
      return fail(`commandId ${commandId} was reused with different arguments`);
    }
    seen.set(commandId, serialized);
  }

  return {
    pass: true,
    score: 1,
    reason: `${mutations.length} workspace mutation(s) used valid command IDs and ETags`,
  };
}
