---
title: Add a container or module
args:
  source: Git URL or local/OneDrive path (new container).
  name: Container name (defaults to the source basename) or module display name.
  sync: Git write mode for a new container.
  backend: Label a path source as local or onedrive.
  container: Target container (new module).
  path: Module folder path within the container (new module).
  type: "Module type: a built-in (knowledge, skills, tools, memory, project) or a custom type name (new module)."
  description: One-line module description (new module).
  config: Optional module config.
  create: Apply the change. Omit to preview a plan (no changes).
---
Add a container with { source, name?, sync?, backend? } (source is a git URL or a local/OneDrive path), or add a module with { container, path, type, config? }. By default add returns a plan and makes no changes; show it to the user, get confirmation, then re-call with create:true.
