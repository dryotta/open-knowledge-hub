---
okf_version: "0.1"
---

# Health

> **Purpose:** David's personal health knowledge — conditions, medical history, and lab results.

## Goals

Track David's own health: conditions and their status, a medical-history timeline, and
longitudinal lab/bloodwork results, plus reference notes that help interpret them.

## Requirements

- Record and look up **conditions** (diagnosis, status, notes).
- Maintain a **medical history** timeline (events, procedures, dates).
- Record **lab results / bloodwork trends** (panel, analyte, value, unit, date) with reference ranges.
- Store **reference** notes that help interpret the above.

**Out of scope:** appointment scheduling, medication management, fitness/nutrition/sleep tracking.

## Structure

- **Folders / groups** — flat for now; concepts live at the module root, grouped later as topics settle.
- **Concept types** — `condition`, `history-event`, `lab-result`, `reference`.
- **Tags** — optional, e.g. the analyte or panel name.
- **Cross-linking** — bundle-relative links between related concepts.

## Sources

- **Retain copies:** yes
- **Folder:** `./sources/`
- **Bucketing:** by month — `<YYYY-MM>/` (the ingest date)

## Concepts

_None yet._
