---
title: Config (view or edit global + module + container settings)
args:
  set: 'Key/value pairs to set, e.g. { wakePhrase: "brain" }. A null value deletes a key. Omit to view instead of edit.'
  container: 'Container name — with `module`, scopes to a module''s config; alone, scopes to the container''s wiki publishing flag; omit for global config.'
  module: Module folder name — provide with container to scope to that module's config.
---
View or edit OKH configuration. The scope is chosen by whether `container`/`module` are given; `set` is the edit verb for both.

**Global config** (no `container`/`module`) — stored in the preferences file:
- Call with no args to view all global settings. Known keys: {{var:configKeys}}.
- Pass { set: { <key>: <value> } } to change them. Known keys are validated; other keys are accepted so the store can be extended without code changes. Set a key to null to delete it.

**Module config** ({ container, module }) — stored in the module's manifest:
- With no `set`, view the module's config: its `type`, `description`, and any custom keys.
- Pass { container, module, set: { <key>: <value> } } to edit. `description` updates the module's one-line routing description (the `dream` flow persists here); any other key is stored in the manifest's config map, and a null value deletes a custom key. `type` cannot be changed (it selects the loader).

**Container config** ({ container }, no `module`) — stored in the registry:
- With no `set`, view the container's wiki publishing state.
- Pass { container, set: { wiki: { enabled: true|false } } } to turn GitHub wiki sync on or off. Enabling scaffolds a version-pinned `.github/workflows/okh-wiki.yml`; disabling removes it. Run `sync` afterward to commit the change — publishing then runs in CI on every push to `main`, and reverse sync runs when the wiki is edited. Choose which modules to publish per module via `wiki-sync: true` (plus optional `wiki-sync-reverse-mode` and `wiki-sync-expanded`) in each `.okh/module.yaml`. The repo's Wikis feature must be enabled once in Settings → Features.
