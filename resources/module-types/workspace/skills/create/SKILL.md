---
name: create
description: Create one focused active project in this workspace from a user's goal, guidance, acceptance additions, target date, and tags.
---

# Create a workspace project

For every mutation, obtain `commandId` from an actual RFC 4122 UUID generator available
to the client. Never type or invent a UUID-shaped value.

1. Call `workspace { operation: "get", container, module }` to verify the workspace is
   initialized and its agent references are valid.
2. Derive one immutable lowercase kebab-case project ID, a concise title, and a
   concrete goal from the user's request. Gather only useful optional detail:
   project guidance, acceptance additions, target date, and normalized tags.
   Set `targetDate` only when the user supplied a complete, unambiguous calendar date;
   never infer a missing year or substitute today's date.
3. Generate one UUID with that facility and call:

   ```text
   workspace {
     operation: "create",
     container,
     module,
     project: "<lowercase-kebab-id>",
     title: "<title>",
     goal: "<durable goal>",
     guidance: "<optional project guidance>",
     acceptance: ["<optional additional criterion>"],
     targetDate: "YYYY-MM-DD",
     tags: ["lowercase-tag"],
     commandId: "<uuid>"
   }
   ```

   Omit optional fields that add no value. Never set status, timestamps, activeRun, or
   result; the Hub owns them.
4. Call `sync` for the container.
5. If the user also asked to execute the project now, continue with this workspace's
   `coordinate` skill using the newly returned project ID and ETag.

Creating a project does not start a run. Do not invent a plan, delegated tasks, or
result files during this skill.
