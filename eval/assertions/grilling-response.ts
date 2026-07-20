interface Ctx {
  providerResponse?: { metadata?: { finalMessage?: string } };
}

function hasPayload(value: string): boolean {
  return /[A-Za-z0-9]/.test(value);
}

function startsWithQuestion(value: string): boolean {
  const withoutListPrefix = value.trimStart().replace(/^(?:(?:[-+*]|\d+[.)])\s*)+/, "");
  return /^(?:question\s*:\s*)?(?:must|shall|should|would|could|can|may|might|do|does|did|have|has|had|what|which|why|how|who|when|where|will|is|are)\b/i.test(withoutListPrefix);
}

function startsAsQuestion(message: string, index: number): boolean {
  const prefix = message.slice(0, index);
  const boundary = Math.max(
    prefix.lastIndexOf("."),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
    prefix.lastIndexOf("\n"),
  );
  const clauseStart = prefix.slice(boundary + 1).trim();
  return startsWithQuestion(clauseStart);
}

function endsAsQuestion(message: string, match: RegExpExecArray): boolean {
  return message.slice(match.index + match[0].length).trimStart().startsWith("?");
}

function includesRecommendation(message: string): boolean {
  const normalized = message.replace(/[*_]/g, "");
  const statements = [
    /\b(?:I|we)(?:['\u2019]d| would)?\s+(?:recommend|suggest)\s+([^.!?\n]+)/gi,
    /\b(?:here(?:['\u2019]s| is)\s+)?(?:my|our|the)\s+(?:recommendation|suggestion|recommended answer|suggested answer)\s*(?:is\b|would\s+be\b|:|[-\u2013\u2014])\s*([^.!?\n]+)/gi,
  ];

  for (const pattern of statements) {
    for (const match of normalized.matchAll(pattern)) {
      if (
        hasPayload(match[1] ?? "")
        && !startsAsQuestion(normalized, match.index)
        && !endsAsQuestion(normalized, match)
      ) return true;
    }
  }

  const labels = /(?:^|[\n.!?;])\s*(?:[-+]\s+)?(?:recommendation|recommended(?: answer)?|suggestion|suggested(?: answer)?)\s*(?::|[-\u2013\u2014])\s*([^.!?\n]+)/gim;
  return [...normalized.matchAll(labels)].some((match) => (
    hasPayload(match[1] ?? "")
    && !startsWithQuestion(match[1] ?? "")
    && !endsAsQuestion(normalized, match)
  ));
}

/** Validates the first turn of the one-decision-at-a-time grilling instructions. */
export default function grillingResponse(_output: string, context: Ctx) {
  const message = context.providerResponse?.metadata?.finalMessage;
  if (typeof message !== "string" || message.trim().length === 0) {
    return { pass: false, score: 0, reason: "final-message metadata is missing or empty" };
  }

  const questionCount = message.match(/\?/g)?.length ?? 0;
  const hasRecommendation = includesRecommendation(message);
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
