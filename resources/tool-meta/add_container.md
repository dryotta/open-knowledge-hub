---
title: Add a container
args:
  source: Git URL or local/OneDrive path for the new container.
  name: Container name (defaults to the source basename).
  sync: Git write mode for the container.
  backend: Label a path source as local or onedrive.
  create: Apply the change. Omit to preview a plan (no changes).
---
Register a container from { source, name?, sync?, backend? } — source is a git URL or a local/OneDrive path. By default this returns a plan and makes no changes; show it to the user, get confirmation, then re-call with create:true.
