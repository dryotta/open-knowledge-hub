---
title: Config (view settings or set a module description)
args:
  set: 'Config keys to set, e.g. { wakePhrase: "brain" }. Omit (and omit the module fields) to list current config.'
  container: Container holding the module whose description you want to set (use with module + description).
  module: Module folder name whose description you want to set (use with container + description).
  description: New one-line module description to persist to the module manifest (use with container + module).
---
View or change OKH configuration, or set a module's manifest description.

- Call with no args to list current settings.
- Pass { set: { <key>: <value> } } to change preferences. Known keys: {{var:configKeys}}.
- Pass { container, module, description } to deterministically write a module's one-line description (the `dream`/`sleep` consolidation flow uses this to keep descriptions accurate for routing). Provide either { set } or the module fields, not both.
