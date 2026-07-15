---
okf_version: "0.1"
---

# Skills module

<!--
Scope contract + index for this skills pack. `scaffold` writes this file; keep it current as you
add or remove skills. Replace each TODO and delete these comment hints as you go. This file is the
module's overview — it is what the hub shows first, so make the scope decision easy to read.
-->

> **Purpose:** TODO — one line on the kind of skills this module holds.

## Goals

TODO — 1–3 sentences: who runs these skills and what they accomplish. Goals are the yardstick for
deciding whether a new skill belongs in this module or in a new one.

## What belongs here

TODO — the shared theme that qualifies a skill for this module (e.g. "Azure DevOps CLI workflows",
"release + deploy procedures"). If a candidate skill does not fit this theme, add it to a different
skills module instead of stretching this one.

**Out of scope:** TODO — kinds of skills that deliberately live in another module, and briefly why.

## Structure

How the pack is organized:

- **Skill folders** — each skill is a folder containing a `SKILL.md` (name + description frontmatter,
  procedure in the body). Bundled resource files (scripts, templates) live alongside `SKILL.md` in
  the same folder.
- **Subfolders** — group related skills under organizational subfolders at any depth (e.g.
  `azure/pipelines/`, `azure/repos/`). A subfolder that only groups skills has no `SKILL.md` of its
  own; discovery descends through it until it reaches each skill folder.
- **Overrides** — a skill under `.okh/skills/` or `.claude/skills/` shadows a same-named skill at the
  module root, so an external convention can be adopted and then selectively overridden.

## Skills

Listing of the skills in this module (name — one-line description). Keep it in sync as skills change;
if this section is removed the hub falls back to a generated listing.

_None yet._
