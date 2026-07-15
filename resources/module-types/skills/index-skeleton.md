# Skills module

<!--
Scope contract and progressive-disclosure index for a reusable skill collection.
`initialize` fills this in. Replace each TODO and delete these hints as you go.
-->

> **Purpose:** TODO - one line on what this skill collection enables.

## Goals

TODO - who uses these skills and what work they should make reliable or repeatable.

## Scope

- **In scope:** TODO - the capability areas this module owns.
- **Out of scope:** TODO - areas that belong in another skills module, and why.

## Structure

Organize cohesive capabilities into an arbitrary-depth area tree:

```text
<area>/
  index.md                 # area purpose and direct-child catalog
  <subarea>/
    index.md
    <skill-name>/
      SKILL.md             # skill leaf
      <resources...>       # scripts, references, templates, and other bundled files
```

- A directory containing `SKILL.md` is a **skill leaf**. Everything below it is that
  skill's resource bundle, not another group.
- Directories without `SKILL.md` are **groups**. For large groups, keep an `index.md`
  that explains the area and catalogs only its direct children.
- Skill frontmatter `name` values must be unique within this module. The same name may
  exist in another skills module because `run` also targets a container and module.
- Keep one module cohesive. Split skills into another module when scope, audience,
  ownership, access, or sync lifecycle differs.

## Naming

TODO - folder and skill naming rules. Prefer stable, descriptive, lowercase kebab-case
folder names; do not encode temporary ordering in paths.

## Catalog

List top-level areas only. Let each area's `index.md` disclose the next level.

_None yet._
