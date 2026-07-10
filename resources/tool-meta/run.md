---
title: Run (module skill)
args:
  container: Container name. Provide with module to run a module skill; omit both to run a shared skill.
  module: Module path within the container. Provide with container; omit both to run a shared skill.
  skill: "Skill name to run: a module skill (with container+module) or a shared skill (see the referencing skill, e.g. grilling, okf-writer)."
  input: Freeform payload passed to the skill (e.g. the knowledge to learn, the observation to remember).
---
Return the discipline for a module's skill (resolved from the module's type + its own skills), with the target paths and your input injected. Guidance only: this returns instructions, it does not perform the work itself.
