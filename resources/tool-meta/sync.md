---
title: Sync containers
args:
  container: "Container to sync (default: all). Required when using action."
  message: Commit message.
  action: "Named action to execute (e.g. `\"publish-pr\"`). Requires container. For shared-mode Git containers, `\"publish-pr\"` opens or finds a pull request from the shared branch to main."
---
Validate and synchronize a container (or all containers). For auto-mode Git containers, commits local changes and pushes to origin. For shared-mode Git containers, commits and pushes to the user's shared branch; use action `"publish-pr"` to open a PR. Pass container to target a single container; omit to sync all.
