---
title: Prepare a Hub agent
args:
  container: Container containing the agents module.
  module: Agents module path within the container.
  agent: Agent ID returned by inspect.
  task: Exact task to give the selected agent.
---
Load one stateless GitHub Copilot agent profile and pair it with a task. This tool only prepares instructions; it does not run a model, create a run, or persist state. Prefer delegating the returned profile and task to a native subagent that can access the needed tools. If that is unavailable, follow the profile in the parent context for this task only. Report `native-subagent` or `inline-parent`; never claim the Hub enforced the model, tools, permissions, or isolation.
