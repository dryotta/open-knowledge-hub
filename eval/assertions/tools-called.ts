interface Ctx {
  config?: { expect?: string[] };
  providerResponse?: { metadata?: { toolCalls?: string[] } };
}

/** Pass iff every expected OKH tool appears in the run's detected tool calls. */
export default function toolsCalled(_output: string, context: Ctx) {
  const expected = context.config?.expect ?? [];
  const called = context.providerResponse?.metadata?.toolCalls ?? [];
  const missing = expected.filter((t) => !called.includes(t));
  const pass = missing.length === 0;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass ? `tools called: ${called.join(", ") || "(none)"}` : `missing tool calls: ${missing.join(", ")}`,
  };
}
