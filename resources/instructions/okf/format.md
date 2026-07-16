---
title: OKF format
description: Quick reference for authoring conformant Open Knowledge Format bundles.
---

# OKF Format (quick reference)

A condensed reference for authoring [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
(OKF) v0.1 bundles. For the authoritative spec, see upstream `SPEC.md`. This file captures the
rules an author needs at hand.

## Bundle

A bundle is a directory tree of markdown files. Distribute it as a git repo (recommended), a
subdirectory of a larger repo, or a tarball.

```
knowledge/<pack-name>/
├── index.md                 # Progressive-disclosure listing (see below). May carry frontmatter.
├── log.md                   # Optional. Chronological update history.
├── <concept>.md             # A concept at the bundle root.
└── <group>/
    ├── index.md
    └── <concept>.md
```

**Reserved filenames** (must not be used for concepts): `index.md`, `log.md`.
All other `.md` files are concept documents.

## Concept document

Two parts: a YAML frontmatter block, then a markdown body.

```markdown
---
type: <Type name>                 # REQUIRED — short, descriptive, self-explanatory
title: <Display name>             # Recommended
description: <One-line summary>    # Recommended — used in index listings & previews
resource: <Canonical URI>          # Optional — for concepts bound to a physical asset
tags: [<tag>, <tag>]               # Optional
timestamp: <ISO 8601 datetime>     # Optional — last meaningful change
# producer-defined extra keys are allowed (e.g. source_commit, target_question)
---

# Schema | Overview | Examples | ...

Structural markdown (headings, lists, tables, fenced code) is preferred over prose — it aids
both human reading and agent retrieval.

# Citations

[1] [path/to/source.ext:45](../../path/to/source.ext) — what this supports
```

- `type` is the only required field. Consumers must tolerate unknown types.
- Conventional body headings: `# Schema`, `# Examples`, `# Citations`. None are required.
- Producers may add arbitrary frontmatter keys; consumers preserve unknown keys.

## Cross-linking

Concepts link to each other with standard markdown links.

- **Absolute (bundle-relative)** — begins with `/`, relative to the bundle root. **Preferred**
  (stable when files move within a subdirectory): `[customers](/tables/customers.md)`.
- **Relative** — `[neighbor](./other.md)`.

A link asserts an untyped relationship; the *kind* of relationship is conveyed by surrounding
prose. Broken links are tolerated (they may be not-yet-written knowledge).

## index.md (progressive disclosure)

No frontmatter, **except** the bundle-root `index.md` may declare `okf_version: "0.1"`. Body is
grouped sections of links with descriptions:

```markdown
# Group Heading

* [Title](relative-url) - short description
* [Subgroup](subdir/) - short description
```

Include the linked concept's `description` as the entry text. Producers may generate `index.md`
automatically.

## log.md (optional)

Date-grouped entries, newest first; ISO `YYYY-MM-DD` headings:

```markdown
# Update Log

## 2026-06-30
* **Creation**: Established [auth flow](/flows/auth.md).
* **Update**: Refined the data-model concept.
```

## Citations

Claims sourced from external/material should be listed under a `# Citations` heading, numbered.
For code knowledge, cite repository paths (optionally `path:line`) and record the generation
commit SHA so staleness is detectable later.

## Conformance

A bundle is conformant if:

1. Every non-reserved `.md` file has a parseable YAML frontmatter block.
2. Every frontmatter block has a non-empty `type`.
3. `index.md` / `log.md` follow their structures when present.

Consumers must NOT reject a bundle for: missing optional fields, unknown `type` values, unknown
extra keys, broken cross-links, or missing `index.md`. Author permissively in the same spirit.
