---
title: Sleep (consolidate module descriptions)
args:
  container: "Container to consolidate (default: all registered containers)."
  module: Module folder name within the container to consolidate (requires container).
---
Return the `dream` consolidation discipline for the resolved module(s): read each module's `index.md` overview and rewrite its one-line manifest description so `inspect` routes issues accurately, persisting each via `config { container, module, description }`. Guidance only: this returns instructions; it does not read files or write descriptions itself.
