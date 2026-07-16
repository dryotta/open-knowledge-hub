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
  const hasRecommendation =
    /\b(?:I|we)(?:['\u2019]d| would)?\s+(?:recommend|suggest)\b/i.test(message)
    || /\b(?:my|the)\s+(?:recommendation|suggestion|recommended answer|suggested answer)\s+(?:is|would be)\b/i.test(message)
    || /(?:^|[\n.!?;])\s*[*_]*(?:(?:my|the)\s+)?(?:recommendation|recommended(?: answer)?|suggestion|suggested(?: answer)?)[*_]*\s*:/im.test(message);
  const referencesPlan = /\b(?:OAuth|GitHub|token|session|callback|state)\b/i.test(message);
  const failures = [
    ...(questionCount >= 1 && questionCount <= 3 ? [] : [`expected one compact decision prompt (1-3 questions), found ${questionCount}`]),
    ...(hasRecommendation ? [] : ["missing a recommendation for the question"]),
    ...(referencesPlan ? [] : ["question does not reference the supplied plan"]),
  ];
  return {
    pass: failures.length === 0,
    score: failures.length === 0 ? 1 : 0,
    reason: failures.length === 0 ? "grilling began with one plan-specific decision prompt and recommendation" : failures.join("; "),
  };
}
