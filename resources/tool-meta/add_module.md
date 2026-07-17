---
title: Add a module
args:
  container: Target container (required when create:true).
  path: "Module folder name within the container — a single top-level segment (modules cannot be nested). This name is the module's identity (required when create:true)."
  type: "Module type: a built-in (knowledge, skills, memory, llmwiki, agents) or a custom type name (required when create:true)."
  description: "One-line description of what the module holds and who reads it — it drives inspect routing (required when create:true; refine later with dream)."
  config: Optional module config.
  create: Apply the change. Omit to get a step-by-step workflow (no changes).
---
By default this returns a step-by-step workflow for adding, creating, and initializing a module — follow it: understand the need, propose { container, path, type, description } and get the user's agreement, then re-call with create:true to apply, and run the type's initialize skill if it has one. A module's identity is its folder name (the `path`); modules live directly under the container root and cannot be nested.
