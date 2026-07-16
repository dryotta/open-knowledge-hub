---
name: lint
description: Health-check this llmwiki — read the deterministic structural report, then fix contradictions, stale claims, and missing links, and suggest what to write next.
---

# Lint an llmwiki module

Keep the wiki healthy as it grows. Structural checks are computed for you deterministically; your
job is the **judgment** on top. Run these stages in order.

## Stage 1 — Read the structural report

Run `inspect { container, module }`. Its **Wiki health** block lists, deterministically:

- **orphans** — pages with no inbound link from another page
- **dangling links** — links whose target file does not exist
- **uncataloged** — pages missing from `index.md`
- **missing type** — pages whose frontmatter lacks an OKF `type`

## Stage 2 — Fix the mechanical issues

Author edits with the global **okf-writer** skill (`run { skill: "okf-writer" }`):

- Add the missing inbound links (or, if a page truly belongs nowhere, question whether it should
  exist).
- Resolve each dangling link: create the not-yet-written page, or correct the link.
- Add uncataloged pages to `index.md`; add a `type` to any page missing one.

## Stage 3 — The judgment sweep

Read the wiki (start from `index.md`) and look for what a machine can't:

- **Contradictions** between pages — reconcile, or flag both claims.
- **Stale claims** newer material has superseded — update and note in the log.
- **Missing pages** — concepts mentioned repeatedly but lacking their own page.
- **Missing cross-references** — related pages that should link but don't.
- **Thin or unsupported pages** — strengthen, ground, or prune.

Fix what you can safely; **report** anything needing a human decision; **suggest** new questions to
explore or sources to find.

## Stage 4 — Log it

Append a dated `Lint` entry to `log.md`: what you fixed, what you flagged, and what to do next.

## Completion criterion

- Every structural issue from `inspect` is fixed or explicitly deferred with a reason.
- Contradictions and stale claims are reconciled or flagged.
- `log.md` records the pass and its follow-ups.
