/**
 * Typed error for all expected, user-facing failures in open-knowledge-hub.
 *
 * Tool handlers catch OkhError and return a clean `isError` result to the client
 * instead of leaking a stack trace. Unexpected errors bubble up as real crashes.
 */
export type OkhErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "ALREADY_EXISTS"
  | "NOT_INSTALLED"
  | "ALREADY_INSTALLED"
  | "DIRTY_WORKTREE"
  | "UNPUSHED_COMMITS"
  | "INVALID_ARGUMENT"
  | "INVALID_MANIFEST"
  | "GIT_ERROR"
  | "GH_ERROR";

export class OkhError extends Error {
  readonly code: OkhErrorCode;
  /** Optional structured hint surfaced to the caller (e.g. troubleshooting steps). */
  readonly hint?: string;

  constructor(code: OkhErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "OkhError";
    this.code = code;
    this.hint = hint;
  }
}

export function isOkhError(err: unknown): err is OkhError {
  return err instanceof OkhError;
}
