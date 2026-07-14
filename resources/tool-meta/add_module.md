---
title: Add a module
args:
  container: Target container (required when create:true).
  path: Module folder path within the container (required when create:true).
  type: "Module type: a built-in (knowledge, skills, memory, llmwiki) or a custom type name (required when create:true)."
  name: Module display name (required when create:true).
  description: One-line module description.
  config: Optional module config.
  create: Apply the change. Omit to get a step-by-step workflow (no changes).
---
By default this returns a step-by-step workflow for adding, creating, and initializing a module — follow it: understand the need, propose { container, path, type, name, description } and get the user's agreement, then re-call with create:true to apply, and run the type's initialize skill if it has one.
