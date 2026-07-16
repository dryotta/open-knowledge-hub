interface Ctx {
  config?: {
    required?: string[];
    forbidden?: string[];
  };
  providerResponse?: { metadata?: { finalMessage?: string } };
}

function selectedSection(message: string): string {
  const boundaries = [
    /^#{1,6}\s+(?:gaps?|missing(?:\s+coverage)?|limitations?|excluded|rejected|omitted|not selected|what(?:'s| is) missing)\b/im,
    /^(?:\*\*)?(?:gaps?|missing(?:\s+coverage)?|limitations?|what(?:'s| is) missing)(?:\*\*)?\s*:/im,
  ];
  const indexes = boundaries
    .map((pattern) => pattern.exec(message)?.index)
    .filter((index): index is number => index !== undefined);
  const boundary = indexes.length === 0 ? undefined : Math.min(...indexes);
  return boundary === undefined ? message : message.slice(0, boundary);
}

function selectedItems(message: string): string {
  const negative = /\b(?:no relevant|not relevant|unrelated|rejected|excluded|not selected|does not apply|doesn't apply)\b/i;
  return selectedSection(message)
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line))
    .filter((line) => !negative.test(line))
    .join("\n");
}

/** Checks selected working-set entries without treating a later gap summary as a selection. */
export default function workingSetSelection(_output: string, context: Ctx) {
  const message = context.providerResponse?.metadata?.finalMessage;
  if (typeof message !== "string" || message.trim().length === 0) {
    return { pass: false, score: 0, reason: "final-message metadata is missing or empty" };
  }
  const selection = selectedItems(message);
  const missing = (context.config?.required ?? []).filter((pattern) => !new RegExp(pattern, "i").test(selection));
  const selectedForbidden = (context.config?.forbidden ?? []).filter((pattern) => new RegExp(pattern, "i").test(selection));
  const pass = missing.length === 0 && selectedForbidden.length === 0;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? "selected working set contains only required relevant entries"
      : `missing selected: [${missing.join(", ")}] forbidden selected: [${selectedForbidden.join(", ")}]`,
  };
}
