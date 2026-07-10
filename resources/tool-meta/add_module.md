---
title: Add a module
args:
  container: Target container.
  path: Module folder path within the container.
  type: "Module type: a built-in (knowledge, skills, tools, memory, project) or a custom type name."
  name: Module display name.
  description: One-line module description.
  config: Optional module config.
  create: Apply the change. Omit to preview a plan (no changes).
---
Add a typed module to a container with { container, path, type, name }. By default this returns a plan and makes no changes; show it to the user, get confirmation, then re-call with create:true.
