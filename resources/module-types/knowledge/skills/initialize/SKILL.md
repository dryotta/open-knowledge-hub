---
name: initialize
description: Populate a newly-created knowledge module by grilling out its requirements and sourcing rules, then gathering and writing only what those requirements demand.
---

# Initialize a knowledge module

The module already exists (name, type, and one-line description were set when it was added).
Your job is to turn it from an empty shell into a **scope-bounded knowledge pack**: it exists
to satisfy a specific, agreed set of requirements — nothing more. Anything that doesn't help
satisfy a requirement does not belong.

The whole point is restraint. A sprawling auto-generated wiki is the failure mode. Resist it.
This skill makes **no assumptions about the subject domain** — a codebase, a product area,
research, personal or organizational know-how. The module's own rules are decided in Stage 1
and written into `index.md`.

## Workflow

Run these stages in order. Each hands off to the next.

### Stage 1 — Grill the requirements

Run the shared **grilling** skill (`run { skill: "grilling" }`) to produce a written **scope
contract**, then write it to the module's `index.md`. The contract has three parts:

- **Goals** — what this module is *for*: who reads it and what they need to accomplish. One to
  three sentences. Goals are the yardstick for every later decision.
- **Requirements** — the concrete things a reader must be able to answer or do from the module.
  For each candidate piece of information, make an explicit decision: **should this module
  manage it, or not?** Every in-scope requirement traces to a goal. List what is explicitly
  **out-of-scope**, and briefly why it doesn't serve the goals.
- **Sourcing & grounding rules** — decided here, not assumed: where this module's knowledge
  comes from (e.g. a code repository, documents, the user's own expertise) and how a claim is
  grounded, cited, and verified **for this module**. If the module documents code, the rules
  might say "cite repository paths and pin a commit SHA" — but that is a per-module choice, not
  a default.

Grill until goals, requirements, out-of-scope, and sourcing rules are sharp and mutually
consistent. Push back on vague or unbounded requirements ("capture everything" is not a
requirement). Iterate with the user to tighten and trim. Do not start gathering in earnest
until the contract is agreed and written to `index.md`.

### Stage 2 — Gather (requirement-guided)

Collect only what the requirements demand, from the sources the contract named. Follow the
threads each requirement opens and **stop once every requirement is satisfiable**. Do not
exhaustively survey the source.

If authoritative prior artifacts exist in the agreed sources, read them as input rather than
re-deriving what they already settle.

### Stage 3 — Grill the gaps

A short second grilling pass (`run { skill: "grilling" }`) — only for claims you found evidence
of but **cannot ground** from the agreed sources (usually "why" / rationale). Resolve each with
the user before it is written, or mark it per the module's grounding rules (e.g. a `⚠️ UNVERIFIED`
flag).

### Stage 4 — Write

Populate the module, applying the module's own grounding rules from the contract. When authoring
an [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) bundle of concept
docs, use the shared **okf-writer** skill (`run { skill: "okf-writer" }`). Every non-trivial claim
is grounded or flagged per the contract; name the requirement each piece serves.

### Stage 5 — Verify (the scope gate)

This is the completion criterion. Spawn a **fresh sub-agent given ONLY the module's content** (no
access to the sources or this conversation) and check it against every requirement.

- If it cannot satisfy a requirement → the module has a gap. Fix it (gather more, or grill the
  user), then re-test.
- **Prune ruthlessly:** anything not needed to satisfy a requirement is out of scope. Cut it.

The module is done only when the fresh reader satisfies **every** requirement and nothing in the
module is unused by those answers.

## Completion criterion

- A written scope contract (goals + requirements + out-of-scope + sourcing/grounding rules)
  exists in the module's `index.md`, with goals justifying every requirement.
- Content is grounded per the module's own rules (cited, flagged, or sourced from grilling).
- A fresh reader sub-agent, given only the module, satisfies every requirement.
- Nothing survives that isn't needed to satisfy a requirement.
