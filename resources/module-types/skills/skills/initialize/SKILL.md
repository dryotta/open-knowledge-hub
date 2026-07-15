---
name: initialize
description: Shape a newly-created skills module — grill out what skills belong in it (vs. a separate module) and how they're organized, then record that scope contract in index.md.
---

# Initialize a skills module

The module already exists (name, type, and description were set when it was added). Give it a
scope-bounded shape: an agreed theme that decides which skills belong here versus in a separate
skills module, and an organization scheme for the skill folders. Restraint is the point — a
catch-all "misc skills" bucket is the failure mode.

No assumptions about the subject — a CLI/tool family, a set of team procedures, a domain workflow,
or personal know-how.

## Stage 1 — Grill the scope and structure

Run the shared **grilling** skill (`run { skill: "grilling" }`), then record the agreed **scope
contract** in the module's `index.md` (its skeleton already lays out these sections):

- **Goals** — what these skills are *for*: who runs them and what they accomplish (1–3 sentences).
  Goals are the yardstick for every later decision.
- **What belongs here** — the shared theme that qualifies a skill for this module (e.g. "Azure
  DevOps CLI workflows", "release + deploy procedures"). Make it concrete enough that, for any
  candidate skill, you can decide **does it belong in this module, or a new one?** List what's
  **out-of-scope** and why — those skills go in a different module rather than stretching this one.
- **Structure** — how to organize the skill folders: the subfolder groups (at any depth, e.g.
  `pipelines/`, `repos/`) and the naming scheme. Each skill is a folder with a `SKILL.md`; grouping
  subfolders have no `SKILL.md` of their own.

Grill until the goals, the belongs-here theme, out-of-scope, and structure are sharp and
consistent. Reject a vague or unbounded scope ("all our automation" is not a theme).

## Stage 2 — Build to the contract

What you do next depends on whether the module already holds skills.

**Empty module (the common case)** — write the scope contract to the root `index.md` and create the
declared group subfolders (empty). **Do not invent skills** — they accrue later, each authored as a
folder with a `SKILL.md`. You're done.

**Existing skills** (an imported set, or folders already present) — review each against the
belongs-here theme:

- **Keep & organize** skills that fit; move them into the declared subfolders.
- **Relocate** skills that don't fit into a more appropriate module (or flag them for one).
- Update the `## Skills` listing in `index.md` so each kept skill appears with its one-line
  description.

## Completion criterion

- A scope contract (goals + belongs-here theme + out-of-scope + structure) exists in `index.md`,
  with goals justifying the theme.
- **Empty module:** the declared group subfolders exist; no invented skills.
- **Existing skills:** every kept skill fits the theme, sits in the declared structure, and is
  listed in `index.md`; anything off-theme has been relocated or flagged.
