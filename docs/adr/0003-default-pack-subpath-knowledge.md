# Default pack subpath is `knowledge/`

A single knowledge pack per repo is stored under a `knowledge/` subfolder by default, rather than
at the repo root. When no subpath is supplied to `catalog_add` / `pack_install` / `pack_create`, the
effective subpath is `knowledge`. Callers opt into a root-level pack by passing `subpath: "."`, and
may pass any other value for custom or multi-pack layouts.

The deciding factor is that a pack's origin repo usually needs repo-level files that are **not** part
of the OKF bundle — a `README.md` describing the repo, a `LICENSE`, CI config, etc. Placing the bundle
at the repo root forces those files to sit alongside concept documents (and `README.md` collides with
OKF's reserved-filename spirit). A `knowledge/` subfolder cleanly separates "the repo" from "the pack".

## Considered Options

- **Root of the repo is the pack (previous default)** (rejected): simplest path, but mixes repo
  scaffolding with bundle contents and leaves nowhere clean to put a repo README/LICENSE. Still fully
  supported via `subpath: "."`.
- **A differently-named folder (`okf/`, `pack/`, `docs/`)** (rejected): `knowledge` reads best for the
  domain and matches the project name; the exact name is a low-stakes convention and remains
  overridable per pack.

## Consequences

- `pack_create` scaffolds the skeleton `index.md` under `knowledge/`; the repo root is left free for
  repo-level files the author adds before `pack_publish`.
- Installing an existing root-level pack now requires an explicit `subpath: "."`; a bare install of a
  root pack will otherwise fail because `knowledge/` does not exist in the origin.
- `resolveSubpath` (in `src/catalog/schema.ts`) centralises this default and the `.`/`/`/empty → root
  normalisation, so every entry point behaves identically.
