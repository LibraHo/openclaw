const HISTORY_REJECTION_REASONS = [
  "field_limit",
  "item_limit",
  "projection_limit",
  "tool_pairing_rejected",
  "unsupported_content",
  "provenance_rejected",
  "malformed_history",
  "history_access_denied",
  "history_read_failed",
] as const;

export type CodexHistoryRejectionReason = (typeof HISTORY_REJECTION_REASONS)[number];
const reasons = new Set<string>(HISTORY_REJECTION_REASONS);

/** Internal diagnostic identity; never derive a reason from arbitrary exception text. */
export class CodexHistoryRejection extends Error {
  constructor(
    readonly reason: CodexHistoryRejectionReason,
    message?: string,
  ) {
    super(message ?? `Codex history rejected: ${reason}`);
    this.name = "CodexHistoryRejection";
  }
}

export function readCodexHistoryRejectionReason(error: unknown): CodexHistoryRejectionReason {
  return error instanceof CodexHistoryRejection && reasons.has(error.reason)
    ? error.reason
    : "history_read_failed";
}
