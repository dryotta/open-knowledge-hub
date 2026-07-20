---
title: Context (flow)
args:
  container: "Container name (default: all registered containers)."
  task: Copy the user's task and all scope/output constraints verbatim. Never add inferred requirements.
---
Return instructions that guide the agent to assemble a task-relevant working set across your containers. Guidance only: this returns instructions, it does not assemble the working set itself.
