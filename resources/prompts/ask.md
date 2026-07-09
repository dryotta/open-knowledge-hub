# OKH: ask

**Question:** {{var:question}}

**Scan these targets:**
{{var:targets}}

Answer using the `ask` discipline: fork a fresh sub-agent that reads only the
relevant module(s), starting from each module's overview (knowledge: index.md;
skills/tools: the listing; memory/project: recent files). Return a distilled,
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
`index.md`). If the path is unknown, ask. Do **not** open the concept docs yourself.

### Stage 2 — Fork: spawn the analysis sub-agent

Spawn a **fresh sub-agent** whose entire job is to answer the question(s) from the pack and return
a token-efficient result. Give it **only**:

- the bundle root path, and
- the verbatim question(s).

Instruct the sub-agent to:

1. **Navigate by progressive disclosure** — start from the root `index.md`, recover the scope
   contract (goals + target questions + out-of-scope), then open **only** the concept docs needed
   to answer the question. Do not read the whole bundle.
2. **Ground every claim** in the pack — cite the concept (and its underlying `# Citations` origin
   URL / `path:line`) it drew each fact from. Carry through any `⚠️ UNVERIFIED` flags rather than
   laundering them into fact.
3. **Return a self-contained answer**, not the source docs. The answer must stand on its own so
   the main context never needs the bundle. Keep it tight — distilled prose, not pasted sections.
4. **Assess scope explicitly.** For each question, say whether the pack actually covers it:
   - Fully answered → give the answer.
   - Partially answered → answer what's covered, name what's missing.
   - Out of scope / absent → say so plainly (referencing the pack's goals/out-of-scope), and do
     not invent an answer.
5. **Suggest next steps** whenever the question opens further ones — follow-up questions worth
   asking, related concepts in the pack to explore next, or, when the answer is missing/partial,
   pointing at the knowledge module's `learn` skill to teach it the new knowledge (or the
   `initialize` skill if the module needs a fresh scope entirely).

### Stage 3 — Relay the distilled answer

Return the sub-agent's answer to the user largely as-is. Structure it as:

- **Answer** — per question, with its citations.
- **Confidence / coverage** — fully answered, partial (with the gap named), or out of scope.
- **Next steps** — suggested follow-up questions and, where relevant, the skill to use
  (ask again for follow-ups, the `learn` skill to fill a gap).

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
