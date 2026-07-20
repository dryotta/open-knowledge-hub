---
name: initialize
description: Initialize a new workspace module with one lead, concise working guidance, and a required acceptance rubric.
---

# Initialize a workspace

Use this only after `add_module` has created a module with `type: workspace`. The
workspace is a reusable workflow; projects are created later.

1. Call `inspect { container, module }` and `config { container, module }`.
2. Establish a concise routing description, one lead agent reference, and an optional
   agent pool. Agent references may be `agent`, `module/agent`, or
   `container/module/agent`; prefer a qualified form when ambiguity is plausible.
3. If the manifest is incomplete, call:

   ```text
   config {
     container,
     module,
     set: {
       description: "<likely user nouns and verbs>",
       lead: "<agent reference>",
       agents: ["<optional agent reference>"]
     }
   }
   ```

4. Gather short shared working guidance and at least one objectively reviewable
   acceptance criterion. Keep purpose and workflow detail in Markdown, not new config
   keys.
5. Generate one UUID and call:

   ```text
   workspace {
     operation: "create",
     container,
     module,
     guidance: "<shared guidance>",
     acceptance: ["<required criterion>"],
     commandId: "<uuid>"
   }
   ```

6. Call `workspace { operation: "get", container, module }`. Resolve invalid agent
   references with `config`; do not create copied profiles inside the workspace.
7. Call `sync { container, message: "Initialize <module> workspace" }`.

Do not create a project, run, task graph, review role, scheduler, or learning policy
during initialization. If the workspace already exists, switch to the `configure`
skill rather than replacing its README.
