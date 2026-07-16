---
title: Run (module skill)
args:
  container: Container name that owns the target module.
  module: Module path within the container.
  skill: Skill name to run; unique within the target module's effective skill set.
  input: Freeform payload passed to the skill (e.g. the knowledge to learn, the observation to remember).
---
This is the mandatory first step for module-skill work. Learn/teach/add-knowledge
requests run `skill: "learn"` on a knowledge module; do not substitute memory.
Explicit remember requests run `skill: "remember"`; other todo changes run
`skill: "todo"` before any deterministic `todos` mutation.

Return the discipline for a module's skill (resolved from the module's type + its own
skills), with the target paths and your input injected. Required common instructions
and bundled files are returned as MCP resource links. Guidance only: this returns
instructions, it does not perform the work itself.
