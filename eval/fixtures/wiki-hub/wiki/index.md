---
okf_version: "0.1"
---

# ML Wiki

> **Purpose:** A living wiki about transformer internals, for engineers and agents.

## Goals

Help a reader (human or agent) understand transformer components and how they connect.

## Scope

- **In scope:** transformer architecture, attention, inference-time optimizations.
- **Out of scope:** training infrastructure, unrelated ML models.

## Structure

- **Groups / folders** — `concepts/`, `entities/`.
- **Concept types** — `concept`, `entity`.
- **Links** — OKF bundle-relative (for example, `/concepts/page.md`). No orphans.

## Sources

Retain copies: no

## Catalog

### concepts
* [Attention](/concepts/attention.md) — how attention weights tokens
* [Positional Encoding](/concepts/positional-encoding.md) — how token order enters the model

### entities
* [Transformer](/entities/transformer.md) — the overall architecture
