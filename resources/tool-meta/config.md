---
title: Config (view or change settings)
args:
  set: 'Config keys to set, e.g. { wakePhrase: "brain" }. Omit to list current config.'
---
View or change OKH configuration (stored in preferences.json). Call with no args to list current settings; pass { set: { <key>: <value> } } to change one or more. Known keys: {{var:configKeys}}.
