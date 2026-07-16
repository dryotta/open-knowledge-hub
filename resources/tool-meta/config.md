---
title: Config (view or edit global + module settings)
args:
  set: 'Key/value pairs to set, e.g. { wakePhrase: "brain" }. A null value deletes a key. Omit to view instead of edit.'
  container: Container name — provide with module to scope to a module's config; omit (with module) for global config.
  module: Module folder name — provide with container to scope to that module's config.
---
View or edit OKH configuration. The scope is chosen by whether `container`/`module` are given; `set` is the edit verb for both.

**Global config** (no `container`/`module`) — stored in the preferences file:
- Call with no args to view all global settings. Known keys: {{var:configKeys}}.
- Pass { set: { <key>: <value> } } to change them. Known keys are validated; other keys are accepted so the store can be extended without code changes. Set a key to null to delete it.

**Module config** ({ container, module }) — stored in the module's manifest:
- With no `set`, view the module's config: its `type`, `description`, and any custom keys.
- Pass { container, module, set: { <key>: <value> } } to edit. `description` updates the module's one-line routing description (the `dream` flow persists here); any other key is stored in the manifest's config map, and a null value deletes a custom key. `type` cannot be changed (it selects the loader).
