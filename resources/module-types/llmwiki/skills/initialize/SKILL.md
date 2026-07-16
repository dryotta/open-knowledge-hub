---
name: initialize
description: Shape a newly-created llmwiki module — grill its scope and pick a structure template, then scaffold that structure (empty wiki) or fit existing content to it.
resources:
  - okh://instructions/grilling.md
  - okh://instructions/ingest.md
  - okh://instructions/okf/writer.md
---

# Initialize an llmwiki module

The module already exists (name, type, and description were set when it was added). Give it a
scope-bounded shape: an agreed scope contract and an organized OKF structure. This wiki is a
*living* knowledge base — it welcomes breadth **within its declared scope** and is read by **both
humans and agents**. The failure mode is a wiki with no boundary, not a small one.

Pages are OKF concept docs, authored later with the
[OKF writer instructions](okh://instructions/okf/writer.md). This skill only sets up the
contract and structure.

## Stage 1 — Grill the scope and structure

You **must read and apply** the [grilling instructions](okh://instructions/grilling.md);
do not emulate or summarize their discipline from memory. After agreement, perform Stage 2 in
this run. Reporting "next steps" without writing the contract and group indexes is not completion.

Record the agreed **scope contract** in the module's root `index.md` (its skeleton lays out these
sections):

- **Purpose & Goals** — one line on what the wiki is for; who reads it (humans and/or agents) and
  what they need. Goals are the yardstick for every later decision.
- **In scope / Out of scope** — the topics this wiki covers and, explicitly, those it does not.
  This is the gate every page is judged against.
- **Structure** — offer a **template menu** and let the user pick and adapt:
  - **Encyclopedia** — `concepts/`, `entities/`, `summaries/`, `syntheses/`
  - **Diátaxis** — `tutorials/`, `how-to/`, `reference/`, `explanation/`
  - **Topic tree** — nested topic folders, each with its own `index.md`
  - **Codebase map** — `components/`, `flows/`, `decisions/`, `glossary/`
  - **Custom** — user-declared folders
  Record the chosen group folders, the OKF concept **`type`** vocabulary (declare each type), and
  any **tags**.
- **Sources retention** (optional) — whether ingested source documents are kept in the module.
  Default **no**. If yes, write a `## Sources` section recording **Retain copies: yes**, the
  **Folder** (default `./sources/`) and **Bucketing** (default `<YYYY-MM>/`). The
  [ingest instructions](okh://instructions/ingest.md) honor this.

Grill until goals, in/out-of-scope, and structure are sharp. Reject unbounded scope — "everything
about X" is not a boundary.

## Stage 2 — Build to the contract

**Empty wiki (the common case)** — write the scope contract to the root `index.md`, create the
declared group folders (each with its own stub `index.md`), and seed `log.md`. **Do not invent
content** — pages accrue through the `write` skill. You're done.

**Existing content** — review it against the scope with the
[OKF writer instructions](okh://instructions/okf/writer.md). Keep and map what fits; cut what's
out of scope; fix or flag `⚠️ UNVERIFIED` any claim you can't back up; note gaps for `write`.
Then update `index.md`'s catalog.

## Completion criterion

- A scope contract (purpose + goals + in/out-of-scope + structure with declared types) exists in
  `index.md`.
- **Empty wiki:** the declared group folders exist (each with `index.md`); `log.md` is seeded; no
  invented content.
- **Existing content:** it follows the structure and stays within scope; every claim is backed or
  flagged.
