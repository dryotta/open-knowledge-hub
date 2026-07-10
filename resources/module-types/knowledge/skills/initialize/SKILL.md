---
name: initialize
description: Populate a newly-created knowledge module by grilling out its requirements and structure, then gathering and writing only what those requirements demand.
---

# Initialize a knowledge module

The module already exists (name, type, and description were set when it was added). Turn it from
an empty shell into a **scope-bounded knowledge pack** that satisfies a specific, agreed set of
requirements — nothing more. Restraint is the point: a sprawling auto-generated wiki is the
failure mode.

No assumptions about the subject — a codebase, a product area, research, org or personal
know-how. What the module captures and how it's organized are decided in Stage 1 and written to
`index.md`.

## Workflow

Run these stages in order. Each hands off to the next.

### Stage 1 — Grill the requirements and structure

Run the shared **grilling** skill (`run { skill: "grilling" }`), then write the agreed **scope
contract** to the module's `index.md`:

- **Goals** — what this module is *for*: who reads it and what they need to accomplish (1–3
  sentences). Goals are the yardstick for every later decision.
- **Requirements** — the concrete things a reader must be able to answer or do. For each
  candidate piece of information, decide explicitly: **should this module manage it, or not?**
  Every in-scope requirement traces to a goal; list what's **out-of-scope** and why.
- **Structure** — propose how to organize the pack with OKF's building blocks: a folder/group
  layout (subdirectories, each with their own `index.md`), the concept **`type`** vocabulary
  (the labels that classify concepts), and any **`tags`** and cross-linking scheme. Declare it in
  `index.md` so the pack is self-describing; refine it as gathering reveals the real shape.

Optionally record **sourcing conventions** — where the module's knowledge comes from and how
claims are checked (e.g. code: "cite repository paths, pin a commit SHA"). Capture this only when
it helps the module.

Grill until goals, requirements, out-of-scope, and structure are sharp and consistent. Reject
vague or unbounded requirements ("capture everything" is not a requirement). Don't gather in
earnest until the contract is agreed and written.

### Stage 2 — Gather (requirement-guided)

Collect only what the requirements demand, from the agreed sources. Follow the threads each
requirement opens and **stop once every requirement is satisfiable** — don't exhaustively survey.
Treat authoritative prior artifacts as input; don't re-derive what they already settle.

### Stage 3 — Write

Populate the module along the agreed structure. For an
[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) bundle of concept
docs, use the shared **okf-writer** skill (`run { skill: "okf-writer" }`). Name the requirement
each piece serves. If a claim can't be verified from the sources — often a "why" the sources
don't state — confirm it with the user or drop it; don't assert what you can't back up (flag a
kept-but-unverified claim, e.g. `⚠️ UNVERIFIED`).

### Stage 4 — Verify (the scope gate)

The completion gate. Spawn a **fresh sub-agent given ONLY the module's content** and check it
against every requirement:

- Can't satisfy a requirement → a gap; gather more or grill the user, then re-test.
- **Prune ruthlessly** — cut anything not needed to satisfy a requirement.

Done when the fresh reader satisfies **every** requirement and nothing is unused. This gate is
**optional when initializing from imported knowledge** — an existing, already-trusted pack
brought in wholesale rather than authored. Verify authored or derived content, not trusted
imports.

## Completion criterion

- A scope contract (goals + requirements + out-of-scope + structure) exists in `index.md`, goals
  justifying every requirement.
- Content follows the declared structure; every claim is one you can back up (confirmed or
  flagged).
- For authored or derived content, a fresh reader satisfies every requirement and nothing unused
  remains. (Trusted imported knowledge is exempt from the reader-test.)
