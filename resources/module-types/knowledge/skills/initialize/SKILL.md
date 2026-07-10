---
name: initialize
description: Initialize a newly-created knowledge (OKF) module by surveying its target repository into a scope-bounded, question-driven knowledge pack.
---

# Initialize a knowledge module

**Populate a freshly-created `knowledge` module** by surveying its target repository
into a *knowledge pack*: a scope-bounded, question-driven
[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) bundle
of markdown concept docs. The pack exists to answer a specific, agreed list of
questions — nothing more. Anything that does not help answer a target question does
not belong in the pack.

The whole point is restraint. A sprawling auto-generated wiki is the failure mode. Resist it.

## Workflow

Run these stages in order. Each stage has a clear hand-off to the next.

### Stage 1 — Grill the scope

Run the shared **grilling** skill (`run { skill: "grilling" }`) whose **sole purpose** is to produce a written **scope contract**:

- **Goals** — what this knowledge pack is *for*: who reads it and what they need to accomplish
  (e.g. "onboard a new engineer to the billing module so they can ship a fix unaided"). One to
  three sentences. Goals are the yardstick: every target question and scope boundary must serve a
  goal, and later requests to add or change scope are judged against the goals.
- **Target questions** — the concrete questions a reader must be able to answer from the pack.
  Each must trace to a goal.
- **Out-of-scope** — an explicit list of what the pack will *not* cover, and (briefly) why it
  doesn't serve the goals.

Grill until all three are sharp and **mutually consistent**: goals justify every question, no
question falls outside the goals, and the out-of-scope list has no overlap with the questions.
Drive toward questions that are answerable from the repository, and push back on vague or
unbounded ones ("document everything" is not a question). **Iterate with the user** to tighten
the contract — trim redundant or overlapping questions, fold near-duplicates together, and cut
anything that doesn't measurably advance a goal — until goals and scope are concise, consistent,
and tight. Write the agreed scope contract (goals + target questions + out-of-scope) to the
bundle root's `index.md` once known (see `okf-writer`).

Do not start reading the codebase in earnest until the scope contract is agreed.

### Stage 2 — Explore (question-guided)

Explore the repository to map only the parts needed to answer the target questions. Start from
structural entry points, follow the code paths the questions demand,
and **stop once every question is answerable**. Do not exhaustively read the repo.

If existing knowledge artifacts are present (`CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/`),
read them as authoritative input — do not re-derive what they already settle.

### Stage 3 — Grill the gaps

A second, short grilling pass (`run { skill: "grilling" }`) — only for claims you found evidence of but **cannot verify
from code alone** (almost always "why" questions: why this technology, why this split, what
non-obvious constraint forced this). Resolve each before it is written, or it gets flagged
`⚠️ UNVERIFIED` in the pack.

### Stage 4 — Write the bundle

Use the shared **okf-writer** skill (`run { skill: "okf-writer" }`) to author the OKF bundle. Default location is
`./knowledge/<pack-name>/` inside the target repo (the user may override). Every non-trivial
claim is cited to a repository path; unverifiable claims are flagged `⚠️ UNVERIFIED`.

### Stage 5 — Reader-test (the scope gate)

This is the completion criterion. Spawn a **fresh sub-agent given ONLY the generated bundle**
(no access to the codebase or this conversation) and ask it every target question.

- If it cannot answer a target question correctly → the pack has a gap. Fix it (explore more,
  or grill the user), then re-test.
- **Prune ruthlessly:** any concept, section, or sentence that is *not* needed to answer a
  target question is out of scope. Cut it.

The pack is done only when the fresh reader answers **every** target question correctly and
nothing in the pack is unused by those answers.

## Completion criterion

- A written scope contract (goals + target questions + out-of-scope) exists in the bundle root
  `index.md`, with goals justifying every target question and scope boundary.
- The bundle is OKF-conformant (every concept has parseable frontmatter with a non-empty `type`).
- Every non-trivial claim is either cited to a repo path, flagged `⚠️ UNVERIFIED`, or sourced
  from the grilling session.
- A fresh reader sub-agent, given only the bundle, answers every target question correctly.
- No concept or section survives that isn't needed to answer a target question.
