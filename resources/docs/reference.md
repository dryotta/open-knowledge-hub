---
title: Reference
description: Complete current reference for OKH tools, resources, module types, built-in skills, manifests, configuration, and template variables.
---

# Reference

## MCP tools

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `inspect` | `container?`, `module?` | List the hub map, a container, or one module's items, overview, skills, and health. |
| `add_container` | `source`, `name?`, `sync?`, `backend?`, `create?` | Preview or register/clone a container. |
| `add_module` | `container?`, `path?`, `type?`, `description?`, `config?`, `create?` | Return the module design workflow or create the agreed module. |
| `sync` | `container?`, `message?`, `action?` | Validate and synchronize; `publish-pr` is a shared-mode action. |
| `config` | `set?`, `container?`, `module?` | View/edit global preferences or one module manifest. |
| `todos` | operation plus filters/mutation fields | List, preview, create, or update memory-module todos. |
| `ask` | `container?`, `module?`, `question?` | Return discipline for answering from modules. |
| `context` | `container?`, `task?` | Return discipline for selecting a working set. |
| `run` | `container`, `module`, `skill`, `input?` | Return one module skill and its resource links. |
| `onboard` | none | Return first-run setup guidance. |
| `dream` | `container?`, `module?` | Return description-consolidation guidance. |
| `help` | `question?` | Search canonical docs/common instructions and return relevant resource links. |
| `capabilities` | none | Probe roots, sampling, form elicitation, and MCP Apps support. |

All cognitive tools return guidance for the client agent; they do not run an LLM.
OKH does not register an MCP prompt surface.

## MCP resources

Direct resources:

- `okh://containers`
- `okh://docs/<path>`
- `okh://instructions/<path>`
- `ui://open-knowledge-hub/todos` for MCP App-capable hosts

Templates:

- `okh://containers/{container}`
- `okh://containers/{container}/modules/{module}`
- `okh://containers/{container}/modules/{module}/files/{path}`

Container and module instances are enumerated by `resources/list`. File leaves are
discovered progressively from a module resource and read through the file template.
The server advertises `listChanged`; it does not advertise resource subscriptions.
One module file read is capped at 16 MiB.

## Built-in module types and skills

| Module type | Loader | Built-in skills |
| --- | --- | --- |
| `knowledge` | OKF concepts and `index.md` | `initialize`, `learn` |
| `memory` | Recursive files and optional `README.md` | `reflect`, `remember`, `todo` |
| `llmwiki` | OKF pages, index, log, link health | `initialize`, `write`, `lint` |
| `skills` | Nested `SKILL.md` leaves and `index.md` | `initialize` |
| custom | Generic recursive file listing | None; use local skills |

Common instructions live at:

- `okh://instructions/grilling.md`
- `okh://instructions/ingest.md`
- `okh://instructions/okf/writer.md`
- `okh://instructions/okf/format.md`

They are resources consumed by built-in skills, not module-less skills.

## Module manifest

`<module>/.okh/module.yaml`:

```yaml
type: knowledge
description: Project authentication concepts and decisions
config:
  owner: identity-team
```

`type` is required. `description` defaults to an empty string for legacy/manual
manifests, while the `add_module` workflow requires a meaningful description.
`config` is an optional arbitrary mapping. The module folder name is its identity.
The `config` tool may update `description` and arbitrary config keys but cannot
change `type`.

## Skill format

```yaml
---
name: learn
description: Integrate scope-worthy knowledge.
resources:
  - okh://instructions/grilling.md
---

Skill discipline...
```

`name` is required and unique in the effective module set. `description` is used
for routing. `resources` is an optional array of absolute resource URIs returned as
links by `run`. A skill leaf's sibling files are also returned as module-file links.

## Configuration and variables

Environment variables:

| Variable | Meaning |
| --- | --- |
| `OKH_HOME` | Preferences, registry, and managed clone root; defaults to `~/.open-knowledge-hub`. |
| `OKH_WEB_PORT` | Loopback web UI port; omit or set `0` for a dynamic port. |

Global preferences are stored in `$OKH_HOME/preferences.json`. `wakePhrase` is the
known built-in preference; unknown keys are preserved for extension. A `null`
value in `config { set }` deletes a key.

Internal prompt templates support:

- `{{config:path/to/value}}` - resolve a global preference
- `{{var:path/to/value}}` - resolve a runtime value
- `{{prompt:relative-file.md}}` - include another prompt file

Includes are restricted to `resources/prompts/`; cycles and unresolved values fail.

## Registry and sync

`$OKH_HOME/registry.json` records container name, backend descriptor, local path,
sync descriptor, and addition time. Backends are `git`, `local`, and `onedrive`.
Sync modes are `auto` and `shared`.
