# Containers of typed modules replace the OKF pack catalog

OKH v2 generalizes the v1 "catalog of OKF knowledge packs" into a registry of
**containers**, each a local folder holding typed **modules** (`knowledge`,
`skills`, `tools`, `memory`, `project`) declared in a `.okh/okh.yaml` manifest.
Three deterministic tools (`inspect`, `add`, `sync`) manage containers; five
prompts (`ask`, `context`, `learn`, `remember`, `reflect`) inject discipline text.
The server still runs no LLM (ADR-0001) and reuses the `exec`/`git`/`gh` plumbing
and vendored OKF discipline docs.

## Considered Options

- **Extend v1 packs in place** (rejected): packs are knowledge-only; retrofitting
  skills/tools/memory/project onto the pack/catalog model tangled responsibilities.
- **New pack format** (rejected): OKF is kept for the `knowledge` module; other
  module types get their own simple, discovery-oriented conventions.
- **Server-side execution of skills/tools** (rejected for now): OKH discovers and
  surfaces them; the client agent executes. Preserves the no-reasoning safety model.

## Consequences

- Git writes are hybrid: `sync: auto` commits+pushes directly; `sync: pr` keeps the
  v1 pull-request flow. Selected per container in the manifest.
- The "unified graph", concrete `memory`/`project` formats, and a real search index
  are deferred; initially the agent scans local files directly.
- Adds a `yaml` dependency for the manifest.
