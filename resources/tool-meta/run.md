---
title: Run (module skill)
args:
  container: Container name that owns the target module.
  module: Module path within the container.
  skill: Skill name to run; unique within the target module's effective skill set.
  input: Freeform payload passed to the skill (e.g. the knowledge to learn, the observation to remember).
---
This is the mandatory first step for ordinary module-skill work. Source-document
ingestion is the exception: first call `help { question: "ingest" }`, follow its
routing and confirmation stages, and call `run` only after the user confirms the
plan. Learn/teach/add-knowledge requests run `skill: "learn"` on a knowledge module;
do not substitute memory.
Explicit remember requests run `skill: "remember"`; other todo changes run
`skill: "todo"` before any deterministic `todos` mutation.
For a workspace module, first run the module skill that owns setup, creation, or project
execution: use `configure` or `initialize` for workspace setup, `create` for a new
project, and `coordinate` for starting, resuming, continuing, or revising project work.
Direct reads, external cancellation, explicit archive/restore operations, and a
read-only refusal of an impossible run do not need a skill.

Return the instructions for a module's skill (resolved from the module's type + its own
skills), with the target paths and your input injected. Declared required resources are
embedded when they fit the context budget; oversized requirements are marked for
`read_resource`. All dependencies and bundled files remain available as MCP resource
links. Guidance only: this returns instructions, it does not perform the work itself.
