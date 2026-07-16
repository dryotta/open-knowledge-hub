import type { ToolEvent } from "../copilot.js";

export interface ToolExpectation {
  name: string;
  server?: string;
  arguments?: Record<string, unknown>;
  turn?: number;
}

const DEFAULT_SERVER = "open-knowledge-hub";

/**
 * Recursive deep object subset: every key in `expected` must exist in `actual`
 * with a matching value. Primitives use Object.is; nested objects are compared
 * recursively; arrays are NOT treated as object subsets (must be identical via
 * JSON.stringify equality).
 */
export function isDeepSubset(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (expected === null || actual === null) return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
  }
  if (typeof expected === "object" && typeof actual === "object") {
    const exp = expected as Record<string, unknown>;
    const act = actual as Record<string, unknown>;
    for (const key of Object.keys(exp)) {
      if (!(key in act)) return false;
      if (!isDeepSubset(act[key], exp[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Matches an attempted call by name, server, optional turn, and deep-subset
 * arguments, regardless of completion or success.
 */
export function matchesToolAttempt(event: ToolEvent, expected: ToolExpectation): boolean {
  if (event.tool !== expected.name) return false;
  const server = expected.server ?? DEFAULT_SERVER;
  if (event.server !== server) return false;
  if (expected.turn !== undefined && event.turn !== expected.turn) return false;
  if (expected.arguments !== undefined) {
    if (!isDeepSubset(event.arguments, expected.arguments)) return false;
  }
  return true;
}

/** Matches an attempted call only when it completed successfully. */
export function matchesTool(event: ToolEvent, expected: ToolExpectation): boolean {
  return event.completed && event.success && matchesToolAttempt(event, expected);
}

/**
 * Returns unmatched expectations. When ordered is true, matches must be found
 * monotonically in event order (each successive match must appear at a later
 * index than the previous).
 */
export function missingTools(
  events: ToolEvent[],
  expected: Array<string | ToolExpectation>,
  ordered = false,
): Array<string | ToolExpectation> {
  const expectations = expected.map((e) =>
    typeof e === "string" ? { name: e } : e,
  );

  if (!ordered) {
    const eventAssignments = new Array<number>(events.length).fill(-1);

    const assign = (expectationIndex: number, seenEvents: boolean[]): boolean => {
      const expectation = expectations[expectationIndex]!;
      for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
        if (seenEvents[eventIndex] || !matchesTool(events[eventIndex]!, expectation)) continue;
        seenEvents[eventIndex] = true;
        const previousExpectation = eventAssignments[eventIndex]!;
        if (previousExpectation === -1 || assign(previousExpectation, seenEvents)) {
          eventAssignments[eventIndex] = expectationIndex;
          return true;
        }
      }
      return false;
    };

    for (let i = 0; i < expectations.length; i++) {
      assign(i, new Array<boolean>(events.length).fill(false));
    }

    const matched = new Set(eventAssignments.filter((index) => index !== -1));
    return expected.filter((_expectation, index) => !matched.has(index));
  }

  // Ordered: find matches monotonically
  const unmatched: Array<string | ToolExpectation> = [];
  let cursor = 0;
  for (let i = 0; i < expectations.length; i++) {
    const exp = expectations[i]!;
    let found = false;
    for (let j = cursor; j < events.length; j++) {
      if (matchesTool(events[j]!, exp)) {
        cursor = j + 1;
        found = true;
        break;
      }
    }
    if (!found) unmatched.push(expected[i]!);
  }
  return unmatched;
}
