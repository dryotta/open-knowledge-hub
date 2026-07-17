---
title: Reference
description: Complete current reference for OKH tools, resources, module types, built-in skills, manifests, configuration, and template variables.
---

# Reference

## MCP tools

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `inspect` | `container?`, `module?` | List the hub map with skills nested under modules, a container, or one module's items, overview, skills, and health. |
| `use_agent` | `container`, `module`, `agent`, `task` | Return one exact Copilot profile and task for client-side subagent delegation or inline fallback. |
| `add_container` | `source`, `name?`, `sync?`, `backend?`, `create?` | Preview or register/clone a container. |
| `add_module` | `container?`, `path?`, `type?`, `description?`, `config?`, `create?` | Return the module design workflow or create the agreed module. |
| `sync` | `container?`, `message?`, `action?` | Validate and synchronize; `publish-pr` is a shared-mode action. |
| `config` | `set?`, `container?`, `module?` | View/edit global preferences or one module manifest. |
| `todos` | operation plus filters/mutation fields | List, preview, create, or update memory-module todos. |
| `ask` | `container?`, `module?`, `question?` | Return discipline for answering from modules. |
| `context` | `container?`, `task?` | Return discipline for selecting a working set. |
| `run` | `container`, `module`, `skill`, `input?` | Return one module skill, links, and bounded embedded required resources. |
| `onboard` | none | Return first-run setup guidance. |
| `dream` | `container?`, `module?` | Return description-consolidation guidance. |
| `help` | `question?` | Search canonical docs/common instructions and return bounded embedded matches plus links. |
| `read_resource` | `uri`, `contentIndex?`, `offset?`, `maxBytes?` | Read one bounded chunk from an `okh://` resource as embedded content. |
| `capabilities` | none | Probe MCP client features and report standard MCP subagent delegation as unknown. |

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
- `okh://containers/{container}/{module}`
- `okh://containers/{container}/{module}/files/{path}`

Container and module instances are enumerated by `resources/list`. File leaves are
discovered progressively from a module resource and read through the file template.
The server advertises `listChanged`; it does not advertise resource subscriptions.
One module file read is capped at 16 MiB. Module index resources are bounded and
mark truncated file listings explicitly; known file URIs remain directly readable
when they fit the file-read cap.

Resources are application-driven. A full MCP host reads them with `resources/read`.
For a model on a tool-only host, `read_resource` returns one selected content item in
chunks of 256-49,152 source bytes. Its structured result reports `contentIndex`,
`offset`, `totalBytes`, and `nextOffset`. `help` and `run` proactively embed immediately
required text up to 24 KiB per resource and 64 KiB per tool result; larger requirements
remain linked and are marked for `read_resource`.

## Built-in module types and skills

| Module type | Loader | Built-in skills |
| --- | --- | --- |
| `knowledge` | OKF concepts and `index.md` | `initialize`, `learn` |
| `memory` | Recursive files and optional `README.md` | `reflect`, `remember`, `todo` |
| `llmwiki` | OKF pages, index, log, link health | `initialize`, `write`, `lint` |
| `skills` | Nested `SKILL.md` leaves and `index.md` | `initialize` |
| `agents` | Direct `.github/agents/*.agent.md` and compatible `.md` profiles | None |
| custom | Generic recursive file listing | None; use local skills |

Common instructions live at:

- `okh://instructions/grilling.md`
- `okh://instructions/ingest.md`
- `okh://instructions/okf/writer.md`
- `okh://instructions/okf/format.md`

Module-type skills consume these resources through their declared dependencies.
`run` embeds declared requirements within the context budget and keeps every dependency
available as a canonical link.

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

### Agent profile format

An `agents` module preserves the standard Copilot repository layout:

```text
team-agents/
  .okh/module.yaml
  .github/agents/
    researcher.agent.md
    reviewer.md
```

Profiles remain ordinary YAML-frontmatter Markdown. A non-empty `description` is
required. `.agent.md` is canonical and direct `.md` is accepted for VS Code
compatibility. IDs come from the filename after removing the longest supported
suffix and must be unique case-insensitively. Profiles are read-only definitions;
`use_agent` creates no agent memory, run state, or log.

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
for routing. `resources` is an optional array of URIs that a registered provider can
resolve and read; `run` rejects unsupported or unavailable dependencies. Declared
dependencies are embedded when bounded and otherwise deferred to `read_resource`. A
skill leaf's sibling files are returned as on-demand module-file links. A skill may
declare up to 64 resource URIs; local resource discovery is capped at 128 files, 4,096
visited entries, and 16 directory levels. Exceeding a limit rejects `run`.

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
