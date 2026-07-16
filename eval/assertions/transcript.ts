interface Ctx {
  config?: {
    mustContain?: string[];
    mustNotContain?: string[];
    source?: "transcript" | "final-message";
  };
  providerResponse?: { metadata?: { finalMessage?: string } };
}

/** Pass iff all mustContain patterns match and no mustNotContain pattern matches (case-insensitive). */
export default function transcript(output: string, context: Ctx) {
  const must = context.config?.mustContain ?? [];
  const mustNot = context.config?.mustNotContain ?? [];
  const finalOnly = context.config?.source === "final-message";
  const finalMessage = context.providerResponse?.metadata?.finalMessage;
  if (finalOnly && (typeof finalMessage !== "string" || finalMessage.trim().length === 0)) {
    return { pass: false, score: 0, reason: "final-message metadata is missing or empty" };
  }
  const source = finalOnly ? finalMessage! : output;
  const missing = must.filter((s) => !new RegExp(s, "i").test(source));
  const present = mustNot.filter((s) => new RegExp(s, "i").test(source));
  const pass = missing.length === 0 && present.length === 0;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass ? "transcript matched" : `missing: [${missing.join(", ")}] unexpected: [${present.join(", ")}]`,
  };
}
