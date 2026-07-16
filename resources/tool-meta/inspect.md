---
title: Inspect containers/modules
args:
  container: Container name to inspect.
  module: Module path within the container.
---
List the full hub map (no args): every registered container and module, plus all runnable skills factored by provenance — global (run module-less), built-in per module type (listed once per type in use), and each module's own local skills (also listed by name under each module) — followed by the routing gates. A module's effective skills = its built-in (module-type) skills plus its local skills; a local skill overrides a same-named built-in. With `container`: that container's status and modules. With `container` + `module`: the module's items, overview, skills, and health.
