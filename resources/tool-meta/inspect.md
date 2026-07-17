---
title: Inspect containers/modules
args:
  container: Container name to inspect.
  module: Module path within the container.
---
List the full hub map (no args): every registered container and module, with each
module's complete runnable skill set nested beneath it, followed by the routing
gates. Skills bundled with the module type and skills defined locally in the module
are labeled by origin; a local skill overrides a same-named module-type skill. With
`container`: that container's status and modules. With `container` + `module`: the
module's items, overview, skills, and health.
