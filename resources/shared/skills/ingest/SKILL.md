---
name: ingest
description: Turn source documents (PDFs, docs, images, URLs, or pasted content) into cited candidate knowledge and route each to the target module's own skill for scope-gating and writing.
---

# Ingest source documents

Turn **source documents** — PDFs, docs, images, URLs, or content already pasted into the
conversation — into cited candidate knowledge, then route each candidate to the **target module's
own skill** (`learn` for knowledge, `remember` for memory), which owns the scope gate and the
actual writing. You extract and reason; the target skill decides what earns a place and writes it.

OKH runs no model and never reads files — extraction is **your** job, and OKH **cannot see chat
attachments**. Run these stages in order.

## Stage 1 — Locate the sources (explicitly)

Work only from:
- content already visible to you in this conversation (text the client pasted or attached that you
  can actually read), or
- explicit **file paths or URLs** the user gives you.

You **cannot see chat attachments** through OKH, and you must **never crawl the filesystem
guessing** — no scanning `Downloads`, `Documents`, `Desktop`, or similar. If you have neither
readable content nor explicit locations, **ask the user for them**. Restate the full list of
sources back and confirm it is complete before extracting, so nothing is silently missed.

## Stage 2 — Extract

For each source, obtain its **text** with your own tools — prefer a local extractor (a small PDF
library, or `pdftotext`); use OCR or table extraction only for scanned or image pages. If a source
**can't be read or extracted**, do not invent its contents — list it as a failure and ask how to
proceed.

## Stage 3 — Retain sources (if the module's policy says so)

Read the target module's `index.md` `## Sources` policy — via `inspect { container, module }`
(its overview includes `index.md`) or by reading `index.md` directly. Then:

- **Retain copies: yes** → for each source you **successfully extracted**, copy the original file
  into `<module>/<folder>/<bucket>/<original-filename>` (default `<module>/sources/<YYYY-MM>/`,
  bucketed by the ingest date). Create folders as needed; overwrite on a name collision. Never
  retain a source you could **not** read.
- **Retain copies: no**, or no `## Sources` section → retain nothing.

Retained copies are committed on the next `sync` — flag this for large, binary, or sensitive
documents so the user can opt out.

## Stage 4 — Normalize into candidates (with provenance)

Turn the extracted material into **discrete candidate facts or concepts**. Each candidate carries
a **source citation**:

- retention **on** → cite the **retained in-module path** (`sources/<YYYY-MM>/<file>`) — stable,
  versioned, and synced with the module.
- retention **off** → cite the original file path or URL (plus page/section/row where available).

Group candidates by their likely target module, and (for a knowledge module) by its declared
structure.

## Stage 5 — Route to the target (delegate scope and writing)

Identify the **target module**; if the request doesn't make it clear, ask. Then hand candidates to
the target's own skill — **do not write module files yourself**:

- **knowledge** → `run { container, module, skill: "learn" }`
- **memory** → `run { container, module, skill: "remember" }`

Before writing in bulk, present a short **routing plan**: what goes to which module, and which
candidates look **out of scope**. Get the user's confirmation. Respect the target's scope
contract — if material falls outside it (e.g. a Health module whose contract excludes
metrics/vitals versus attached lab panels), **surface the conflict**: propose a scope change
through the target's grilling, or a different or new module. Never silently drop a candidate, and
never silently expand scope. If the target module already has a scope contract in `index.md`, do
**not** re-initialize it — `learn` reads the existing contract; a module with zero concepts is not
the same as an uninitialized one.

## Stage 6 — Report

Summarize the run: sources ingested; candidates written, grouped by target module; out-of-scope or
deferred candidates; and any sources that failed extraction.

## Completion criterion

- Every provided source is **accounted for** — ingested, deferred, or reported as unreadable.
- If the module retains sources, each successfully-ingested source was copied into the configured
  folder (default `sources/<YYYY-MM>/`) and its concepts cite the retained copy.
- Every **written** candidate carries a source citation and passed the target skill's scope gate.
- Scope conflicts were **surfaced** to the user, not silently resolved.
- No filesystem crawling occurred; missing sources were requested from the user.
