---
title: Add a container
args:
  source: Git URL or local/OneDrive path for the new container.
  name: Container name (defaults to the source basename).
  sync: "Sync mode object `{ mode, config? }`. `mode` is `\"auto\"` (direct push to origin) or `\"shared\"` (personal branch + PR workflow). For Git shared mode, `config.branch` sets the branch name (default: `user/<login>/hub`)."
  backend: Label a path source as local or onedrive.
  create: Apply the change. Omit to preview a plan (no changes).
---
Register a container from { source, name?, sync?, backend? } — source is a git URL or a local/OneDrive path. By default this returns a plan and makes no changes; show it to the user, get confirmation, then re-call with create:true.
