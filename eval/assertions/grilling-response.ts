interface Ctx {
  providerResponse?: { metadata?: { finalMessage?: string } };
}

/** Validates the first turn of the one-decision-at-a-time grilling discipline. */
export default function grillingResponse(_output: string, context: Ctx) {
  const message = context.providerResponse?.metadata?.finalMessage;
  if (typeof message !== "string" || message.trim().length === 0) {
    return { pass: false, score: 0, reason: "final-message metadata is missing or empty" };
  }

  const questionCount = message.match(/\?/g)?.length ?? 0;
  const hasRecommendation = /\b(?:my recommendation|I (?:recommend|suggest)|recommendation|I'd recommend)\b/i.test(message);
  const referencesPlan = /\b(?:OAuth|GitHub|token|session|callback|state)\b/i.test(message);
  const questionText = message.split(/\b(?:my recommendation|I (?:recommend|suggest)|recommendation|I'd recommend)\b/i)[0]!;
  const decisionTopicCount = [
    /\b(?:GitHub|Google|GitLab|Microsoft|OAuth providers?|email\/password)\b/i,
    /\b(?:access tokens?|refresh tokens?|tokens?)\b/i,
    /\b(?:sessions?|backend|cookies?)\b/i,
    /\b(?:callback|state|redirect)\b/i,
    /\b(?:expir\w*|idle|TTL|timeout)\b/i,
  ].filter((pattern) => pattern.test(questionText)).length;
  const failures = [
    ...(questionCount >= 1 && questionCount <= 3 ? [] : [`expected one compact decision prompt (1-3 questions), found ${questionCount}`]),
    ...(decisionTopicCount <= 1 ? [] : [`questions span ${decisionTopicCount} decision topics`]),
    ...(hasRecommendation ? [] : ["missing a recommendation for the question"]),
    ...(referencesPlan ? [] : ["question does not reference the supplied plan"]),
  ];
  return {
    pass: failures.length === 0,
    score: failures.length === 0 ? 1 : 0,
    reason: failures.length === 0 ? "grilling began with one plan-specific decision prompt and recommendation" : failures.join("; "),
  };
}
