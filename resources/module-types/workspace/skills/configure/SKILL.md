---
name: configure
description: Revise a workspace's routing description, lead, agent pool, guidance, or acceptance criteria without changing active run snapshots.
---

# Configure a workspace

1. Call both:

   ```text
   config { container, module }
   workspace { operation: "get", container, module }
   ```

2. Separate settings by authority:
   - `config` owns manifest `description`, `lead`, and `agents`;
   - `workspace:update` owns README working guidance and acceptance criteria.
3. Change only requested values. Use one `config { set }` call for manifest changes.
   `lead` is required; `agents` is an optional flat list. Do not add roles, execution
   modes, budgets, sorting, or project-type schema.
4. For README changes, generate one UUID and use the ETag returned by `workspace:get`:

   ```text
   workspace {
     operation: "update",
     container,
     module,
     patch: {
       guidance: "<replacement guidance>",
       acceptance: ["<complete required rubric>"]
     },
     etag: "sha256:...",
     commandId: "<uuid>"
   }
   ```

   Supply only fields being changed. Workspace acceptance must remain non-empty.
5. Call `workspace:get` again and resolve every reported agent issue.
6. Call `sync` for the container.

Configuration changes affect future runs only. Never alter files under an active run's
`snapshot/`, and never call live `use_agent` to replace a frozen profile.
