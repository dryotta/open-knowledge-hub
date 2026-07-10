---
name: write
description: Integrate new material into this llmwiki — author OKF pages, touch every affected page, maintain cross-links, and update the index and log.
---

# Write to an llmwiki module

Fold new material into this wiki as OKF concept pages, keeping the graph connected and the index
current. A single source or insight typically **touches several pages** — that is expected. Author
all pages with the shared **okf-writer** skill (`run { skill: "okf-writer" }`) for OKF format and
citation rules. Run these stages in order.

## Stage 1 — Load the scope contract

Read the module's `index.md` and recover its **scope contract**: goals, in-scope, out-of-scope.
Restate it in one line. Do not run this on an uninitialized module — if there is no contract, run
`initialize` first. A wiki with zero pages but a written contract is initialized; do not
re-initialize it.

## Stage 2 — The scope gate (coverage within scope)

Unlike a knowledge module's default-NO gate, a wiki **welcomes breadth within its declared scope**.
Decide:

- **In scope** → proceed.
- **Out of scope** → do not silently expand scope. Run the shared **grilling** skill to propose the
  *smallest* scope change that would admit it and get the user's explicit agreement, then re-judge.
  If the user declines, leave it out and say why.

## Stage 3 — Integrate (touch every affected page)

- **Prefer updating existing pages** over creating near-duplicates; create a new page only for a
  genuinely distinct concept/entity.
- Create/update pages under the declared group folders using the declared `type` vocabulary.
- **Cross-link both directions**: link the new/updated page to related pages and add the reciprocal
  links. Use OKF bundle-relative links (`/group/page.md`). A page with no inbound link is an
  orphan — link it.
- **Flag contradictions**: when new material conflicts with an existing page, surface it (note both
  claims) rather than silently overwriting.
- **Ground every non-trivial claim** per okf-writer: cite the source under `# Citations`, or flag
  `⚠️ UNVERIFIED`. Where knowledge comes from the user, attribute it.

## Stage 4 — Update the index and log

- Update the root `index.md` catalog: add new entries, refresh changed descriptions, and declare
  any new `type`.
- Append a dated entry to `log.md` (newest first): what was ingested, pages created/updated, and any
  contradictions flagged.

## Stage 5 — Re-check health

Run `inspect { container, module }` and clear what its **Wiki health** block reports: no orphans, no
dangling links (create the missing page or fix the link), every page cataloged and carrying a
`type`.

## Completion criterion

- Every admitted piece of material is filed into OKF pages within scope, cross-linked both ways, and
  grounded or flagged.
- `index.md` and `log.md` are current.
- `inspect` wiki-health is clean, or the remaining items are intentional and noted in the log.
