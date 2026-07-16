---
title: Inspect containers/modules
args:
  container: Container name to inspect.
  module: Module path within the container.
---
List the full hub map (no args): every registered container and module, plus all runnable skills factored by provenance — global (run module-less), module type (once per module type in use), and each module's own local skills — followed by the routing gates. A module's effective skills = its module type skills (minus any overrides) plus its local skills. With `container`: that container's status and modules. With `container` + `module`: the module's items, overview, skills, and health.
