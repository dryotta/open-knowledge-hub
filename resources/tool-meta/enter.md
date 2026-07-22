---
title: Enter a module to work in it
args:
  container: Container that owns the module to enter.
  module: Module folder name to enter and work in.
---
Declare a module as your working folder and load its context before you start working
in it. Returns the module's absolute path as the working directory, inlines the module's
`AGENTS.md` when one is present, lists the module's runnable skills, and states the write
policy. Read-only and works for every module type. Open Knowledge Hub advises the working
folder and loads context; your client owns and enforces the actual working directory.
