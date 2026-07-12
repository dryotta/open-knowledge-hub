## Write policy

1. Choose exactly one target container/module.
2. Make the requested ordinary content or todo change without confirmation.
3. Inspect and summarize the resulting changes.
4. Call `sync { container }` immediately — do not wait for another turn.
5. Report the summary and sync outcome.

For **shared** sync mode, `sync` pushes the configured branch only. Tell the user
to call sync action `publish-pr` when they are ready to open a pull request. Do not
auto-publish.

**Container and module setup** (add_container / add_module) retains its separate
preview and confirmation step — this policy applies to ordinary content and todo
writes only.
