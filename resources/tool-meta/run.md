---
title: Run (module skill)
args:
  container: Container name. Provide with module to run a module skill; omit both to run a shared skill.
  module: Module path within the container. Provide with container; omit both to run a shared skill.
  skill: "Skill name to run: unique within the target module, or a shared skill name when container/module are omitted (e.g. grilling, okf-writer)."
  input: Freeform payload passed to the skill (e.g. the knowledge to learn, the observation to remember).
---
This is the mandatory first step for module-skill work. Learn/teach/add-knowledge
requests run `skill: "learn"` on a knowledge module; do not substitute memory.
Explicit remember requests run `skill: "remember"`; other todo changes run
`skill: "todo"` before any deterministic `todos` mutation.

Return the discipline for a module's skill (resolved from the module's type + its own skills), with the target paths and your input injected. Guidance only: this returns instructions, it does not perform the work itself.
