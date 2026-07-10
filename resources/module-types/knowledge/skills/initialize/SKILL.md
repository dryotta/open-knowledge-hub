---
name: initialize
description: Shape a newly-created knowledge module — grill out its requirements and structure, then scaffold that structure (empty module) or review and edit existing content to serve it.
---

# Initialize a knowledge module

The module already exists (name, type, and description were set when it was added). Give it a
scope-bounded shape — an agreed set of requirements and an organized structure, nothing more.
Restraint is the point: a sprawling auto-generated wiki is the failure mode.

No assumptions about the subject — a codebase, a product area, research, org or personal
know-how.

## Stage 1 — Grill the requirements and structure

Run the shared **grilling** skill (`run { skill: "grilling" }`), then record the agreed **scope
contract** in the module's `index.md` (its skeleton already lays out these sections):

- **Goals** — what this module is *for*: who reads it and what they need to accomplish (1–3
  sentences). Goals are the yardstick for every later decision.
- **Requirements** — the concrete things a reader must be able to answer or do. For each
  candidate piece of information, decide explicitly: **should this module manage it, or not?**
  Every in-scope requirement traces to a goal; list what's **out-of-scope** and why.
- **Structure** — how to organize the pack with OKF's building blocks: a folder/group layout
  (subdirectories, each with their own `index.md`), the concept **`type`** vocabulary (the labels
  that classify concepts), and any **`tags`** and cross-linking scheme.

Optionally record **sourcing conventions** — where the module's knowledge comes from and how
claims are checked (e.g. code: "cite repository paths, pin a commit SHA"). Capture this only when
it helps the module.

Grill until goals, requirements, out-of-scope, and structure are sharp and consistent. Reject
vague or unbounded requirements ("capture everything" is not a requirement).

## Stage 2 — Build to the contract

What you do next depends on whether the module already holds content.

**Empty module (the common case)** — lay down only the **structure**: write the scope contract to
the root `index.md`, and create the declared group folders with their own `index.md`. **Do not
invent content** — concepts accrue later through the `learn` skill. You're done.

**Existing content** (an imported pack, or material already in the folder) — review it against the
requirements and edit it to fit. For an OKF bundle, author edits with the shared **okf-writer**
skill (`run { skill: "okf-writer" }`):

- **Keep & organize** what serves a requirement; map it into the declared structure.
- **Cut** anything no requirement needs.
- **Fix** claims you can't confirm — check with the user, or flag `⚠️ UNVERIFIED`.
- **Note gaps** where a requirement isn't covered yet; leave them for `learn`, or grill the user.

Then **verify**: spawn a **fresh sub-agent given ONLY the module's content** and check it against
every requirement; fix gaps, prune anything unused, and re-test until the fresh reader satisfies
every requirement with nothing unused. (Skip verification for an already-trusted import brought in
wholesale.)

## Completion criterion

- A scope contract (goals + requirements + out-of-scope + structure) exists in `index.md`, goals
  justifying every requirement.
- **Empty module:** the declared structure exists (group folders + `index.md`); no invented
  content.
- **Existing content:** it follows the structure and serves the requirements, every claim is one
  you can back up, and — unless it's a trusted import — a fresh reader satisfies every requirement
  with nothing unused.
