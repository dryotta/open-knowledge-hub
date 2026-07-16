# Question
{{var:question}}

# Targets to scan
{{var:targets}}

# Instructions
Answer using the `ask` discipline: fork a fresh sub-agent that reads only the
relevant module(s), starting from each module's overview (knowledge/llmwiki: index.md;
skills: the root index and nested paths; memory: recent files). Return a distilled,
**cited** answer. Do not load whole modules into this context.

<discipline name="ask">

# OKF Ask

**Answer questions from a *knowledge pack*** (an
[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) bundle) **without
pulling the bundle into this conversation's context.** A pack can be large; reading it all here
would be wasteful and noisy. Instead, **fork the work to a fresh sub-agent** that reads the pack
in its own context and hands back only a compact, self-contained answer.

The main context should only ever see: the user's question(s), and the sub-agent's distilled
answer. It must **not** see the raw concept docs.

## Workflow

### Stage 1 — Collect the question(s) and pack location

Gather the question(s) the user wants answered and the bundle root path (the directory containing
`index.md`). If the path is unknown, ask. Do **not** open the source files yourself.

### Stage 2 — Fork: spawn the analysis sub-agent

Spawn a **fresh sub-agent** whose entire job is to answer the question(s) from the pack and return
a token-efficient result. For one pack, run it in the foreground and wait for its result. For
independent packs, background sub-agents may run in parallel only if you explicitly wait for every
result before answering; never leave an agent running. Do not inspect a delegated bundle yourself.
Give each sub-agent **only**:

- the bundle root path, and
- the verbatim question(s).

Instruct the sub-agent to:

1. **Navigate by progressive disclosure** — start from the root `index.md`, recover the scope
   contract (goals + target questions + out-of-scope), then open **only** the source files needed
   to answer the question. Do not read the whole bundle.
2. **Ground every claim** in the pack — cite the source item (and its underlying `# Citations` origin
   URL / `path:line`) it drew each fact from. Carry through any `⚠️ UNVERIFIED` flags rather than
   laundering them into fact. Preserve evidentiary strength exactly: correlation is not causation,
   an observation is not a root cause, and absence of detail is not evidence that a behavior does
   not exist. A source joining two facts with "and" does not establish cause: for example,
   "tokens are issued at login and verified on each request" states two mechanisms, not that
   issuance causes verification. Do not add generic benefits, rationale, examples, or likely
   implementation details that the source does not state. Do not specialize a generic source
   term: if the source says `tokens`, do not rewrite it as `access tokens`.
   Use each source's exact path relative to the module root. Never add an assumed directory
   such as `concepts/` when the source path does not contain it. Never attach a source citation
   to a detail that source does not contain; state shared facts and source-specific additions
   separately. For a multi-target answer, identify each source as
   `<container>/<module>/<exact item path>` (for example, `kb-hub/kb/auth.md`).
   When a source says an event
   happens "after", "during", or "on" another event, preserve that wording; do not relabel the
   relationship as causal or correlational unless the source explicitly does so. If asked to
   distinguish the two and the sources establish neither, say that neither classification is
   established rather than forcing each fact into a category. Headings and bullet labels are
   claims too: keep them neutral or source-verbatim, and never use them to add a causal,
   evidentiary, or scope classification that the cited text does not state.
3. **Return a self-contained answer**, not the source docs. The answer must stand on its own so
   the main context never needs the bundle. Keep it tight — distilled prose, not pasted sections.
4. **Honor the caller's output boundary before assessing scope.** Explicit user constraints
   override the default gap elaboration. If the user asks for only stated facts or forbids
   absent details, omit coverage, gap, and next-step sections unless the user explicitly asks
   for a bare coverage status; never name missing technologies, mechanisms, categories, or
   other absent topics. Otherwise, for each question say whether
   the pack fully answers it, partially answers it, or does not cover it, and name only the
   evidence-backed gap.
5. **Suggest next steps when the caller permits them** and the question opens further ones — follow-up questions worth
   asking, related concepts in the pack to explore next, or, when the answer is missing/partial,
   pointing at the knowledge module's `learn` skill to teach it the new knowledge (or the
   `initialize` skill if the module needs a fresh scope entirely). For an llmwiki module, point at
   its `write` skill to file a durable answer back as a page.

A request not to add absent details also forbids listing those absent details as coverage gaps.

### Stage 3 — Relay the distilled answer

Return the sub-agent's answer to the user largely as-is. Do not remove, weaken,
combine, or rewrite the sub-agent's citations when relaying its answer. If the user also requested
follow-up actions, still include the distilled answer itself; do not replace it with a
statement that the answer was retrieved or handled. Before relaying, enforce the original
output boundary. If the sub-agent added a prohibited gap or next-step section, omit that
section without changing its supported facts or valid citations. Verify every citation against
the provided module and item paths; never relay an invented path, and correct only an invalid
path to the exact `<container>/<module>/<item>` identifier. Structure the permitted sections as:

- **Answer** — per question, with its citations.
- **Confidence / coverage** — only when the caller explicitly permits it: fully answered, partial
  (with the gap named), or out of scope.
- **Next steps** — only when the caller permits them: suggested follow-up questions and, where relevant, the skill to use
  (ask again for follow-ups, the `learn` skill to fill a gap).

For a facts-only request, return only the cited facts in the requested grouping and end
after the last fact. Remove cross-source comparisons, coverage notes, and missing-topic summaries.

If a follow-up question arises, ask again rather than holding the bundle open in
context — each ask is a fresh, cheap fork.

## Completion criterion

- The question was answered from a forked sub-agent; the main context never loaded the concept
  docs, only the question and the distilled answer.
- Every claim in the answer traces to a pack concept (and through it to a cited source), with
  `⚠️ UNVERIFIED` flags preserved.
- Coverage is stated honestly: answered, partial (gap named), or out of scope — no invented facts.
- The answer ends with concrete next steps when further questions remain.

</discipline>
