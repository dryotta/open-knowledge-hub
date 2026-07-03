interface Ctx {
  config?: { mustContain?: string[]; mustNotContain?: string[] };
}

/** Pass iff all mustContain patterns match and no mustNotContain pattern matches (case-insensitive). */
export default function transcript(output: string, context: Ctx) {
  const must = context.config?.mustContain ?? [];
  const mustNot = context.config?.mustNotContain ?? [];
  const missing = must.filter((s) => !new RegExp(s, "i").test(output));
  const present = mustNot.filter((s) => new RegExp(s, "i").test(output));
  const pass = missing.length === 0 && present.length === 0;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass ? "transcript matched" : `missing: [${missing.join(", ")}] unexpected: [${present.join(", ")}]`,
  };
}
