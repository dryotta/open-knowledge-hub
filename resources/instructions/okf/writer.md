---
title: OKF writer
description: Author an Open Knowledge Format (OKF) bundle from gathered findings, with every claim grounded in cited sources. Use when a skill needs to write knowledge as a portable markdown bundle.
---

# OKF Writer

Author a knowledge pack as an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
bundle — a directory of markdown concept docs with YAML frontmatter, cross-linked, git-tracked.

The full format rules are in the [OKF format instructions](okh://instructions/okf/format.md).
Read them before writing. This file
is about *how to write a good code-knowledge bundle*, not the spec.

## Where it goes

Default to `./knowledge/<pack-name>/` inside the target repository so the pack versions and diffs
alongside the code. The user may override the path. A bundle is just a directory — no tooling
required to read it.

## Grounding — the non-negotiable rule

A generated pack is only worth what it can be trusted on. So:

- **Every non-trivial claim carries a citation** to a repository path (`path` or `path:line`)
  under the concept's `# Citations` heading. Quote signatures and config keys verbatim rather
  than paraphrasing them.
- **Record the commit SHA** the bundle was generated from (in the root `index.md`), so a future
  run can detect which cited sources have changed.
- **Anything you cannot verify from code** is either resolved by grilling the user first, or
  written with a leading `> ⚠️ UNVERIFIED:` blockquote. Never assert an unverifiable "why" as fact.

## Concept types

OKF does not prescribe a type vocabulary, and neither does this skill. **Invent the `type` values
that fit this repository** (pure OKF minimalism). Two rules only:

1. Pick descriptive, self-explanatory types and use them **consistently** across the bundle.
2. **Declare the types you used** in the root `index.md` (a short "Concept types" list), so the
   bundle is self-describing and index/graph consumers stay coherent.

## Scope discipline

Write a concept **only if it is needed to answer a target question.** Before creating any doc,
name which target question it serves. If you can't, don't write it. The reader-test will prune
anything that slips through, but it's cheaper not to write it.

## Diagrams

Include a Mermaid diagram **only when a target question is inherently structural or temporal** —
e.g. "what are the services and how do they connect?" (a `flowchart`/`graph`) or "how does a
request flow?" (a `sequenceDiagram`), or an `erDiagram` for a data-model question. The diagram
must reflect relationships you verified from imports/config/call-sites. Never add a diagram
decoratively; never invent edges.

## Glossary & decisions

Represent glossary terms and architectural decisions as **OKF concepts inside the bundle** (give
them a fitting `type`, e.g. a glossary-term type and a decision type). If the repo already has a
`CONTEXT.md`, `CONTEXT-MAP.md`, or `docs/adr/`, treat those as authoritative: cite/link them as
sources rather than re-deriving or contradicting them. Do not re-derive what they already settle.

## Index & history

- Generate a root `index.md` for progressive disclosure: the scope contract (goals + target
  questions + out-of-scope), the declared concept types, the generation commit SHA, and a grouped
  listing of concepts with their one-line descriptions. State the **goals** first — they frame why
  the pack exists and are the yardstick for judging any later change to scope. Generate `index.md`
  in subdirectories too when a group has several concepts.
- Optionally maintain a `log.md` recording what each generation run added or changed.

## Completion criterion

- The bundle is OKF-conformant (see the
  [OKF format instructions](okh://instructions/okf/format.md) §Conformance): every
  non-reserved `.md` has parseable frontmatter with a non-empty `type`.
- Root `index.md` carries the scope contract (goals + target questions + out-of-scope), declared
  concept types, and the generation SHA.
- Every non-trivial claim is cited, flagged `⚠️ UNVERIFIED`, or sourced from grilling.
- Every concept names the target question it serves; nothing unused remains.
