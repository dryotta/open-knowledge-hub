---
title: Usage
description: Everyday Open Knowledge Hub workflows and examples, including resources, knowledge, memory, todos, skills, ingestion, and sync.
---

# Usage

The default wake phrase is `hub`. Change it with
`config { set: { wakePhrase: "brain" } }`; restart the MCP client afterward.

## Browse resources

Resources are application-driven in MCP. Full clients can browse with
`resources/list` and `resources/read`; agents on tool-only hosts call
`read_resource { uri }`. Do not pass `okh://` URIs to filesystem or web tools.

Start from:

- `okh://containers` - containers
- `okh://containers/{container}` - one container's modules
- `okh://containers/{container}/{module}` - overview and file links
- `okh://docs/index.md` - canonical product documentation
- `okh://instructions/index.md` - reusable built-in guidance

Module file links are percent-encoded URIs returned by the module resource.
`read_resource` returns at most 48 KiB of source content as a protocol-native embedded
resource. Continue large content with the returned `nextOffset`; select another content
item with `contentIndex`.

## Common requests

| Intent | Example |
| --- | --- |
| Get started | `hub, help me get started` |
| Ask from stored knowledge | `hub, what do we know about authentication?` |
| Gather a working set | `hub, assemble the context needed to build login` |
| Learn | `hub, add this verified token-lifecycle fact to the auth knowledge module` |
| Remember | `hub, remember that the release moved to Friday` |
| Reflect | `hub, reflect on the memory module and propose consolidations` |
| Use a Hub agent | `hub, use the researcher agent to find primary evidence` |
| List todos | `hub, show open todos tagged shopping` |
| Refresh descriptions | `hub, dream on my-notes` |
| Explain OKH | `hub, how should I organize several skill collections?` |

The agent routes module work through `run { container, module, skill, input? }`.
`run` supplies discipline, resource links, and bounded embedded copies of declared
required resources. It does not edit by itself.

## Add containers and modules

`add_container` first returns a plan. Review it, then apply the same request with
`create: true`. Sources may be git URLs or local/OneDrive paths.

`add_module` first returns a design workflow. After agreeing on
`{ container, path, type, description }`, call it with `create: true`. The folder
name is the module identity, and it must be a top-level container child.

## Ingest documents

Say:

> hub, ingest these lab PDFs into my Health module.

Provide readable chat content, explicit file paths, or URLs. The agent calls
`help { question: "ingest" }`, applies the embedded ingest instructions, extracts cited
candidates, checks the target module's scope and source-retention policy, and presents
a routing plan. It must wait for a later confirmation before copying sources, running
the target skill, editing, or syncing.

The confirmed ingest plan continues through the target module's `learn`, `remember`,
or `write` skill, with common guidance supplied through MCP resources.

## Skill modules

Use separate `skills` modules when audience, ownership, access, or sync lifecycle
differs. Inside one module, use an arbitrary-depth area tree:

```text
skills/
  index.md
  engineering/
    index.md
    testing/
      debugging/
        SKILL.md
        references.md
```

A directory with `SKILL.md` is a leaf. Descendants are bundled files for that
skill, exposed as module resources when it runs.

## Agent modules

An `agents` module stores ordinary GitHub Copilot profiles under
`.github/agents/*.agent.md`; compatible direct `.md` profiles are also accepted.
`inspect` lists each profile ID and description. `use_agent` returns the exact
selected profile and task without running a model or writing runtime state.

To add a profile, run the module's `create` skill with the desired role and
constraints. It selects a recipe from the
[agent template catalog](okh://docs/agent-templates.md), writes one focused
`.agent.md` profile, validates it with `inspect`, and synchronizes the container.

The MCP client should prefer a native subagent that accepts the returned
instructions. If unavailable, it follows the profile in the parent context for
that task only. The client reports `native-subagent` or `inline-parent`; OKH keeps
no per-agent memory, history, or execution log.

## Todos and sync

`todos` lists, filters, creates, and updates Markdown checkboxes in memory modules.
Agent-driven writes use `apply: true` and then call `sync`; omit `apply` only for
an explicit preview. Supporting clients render an MCP App, and every result also
includes the loopback `/todos` URL.

`auto` sync validates, commits, and pushes git containers to origin. `shared` sync
validates, commits, rebases the configured personal branch, and pushes it. Use the
`publish-pr` action when the branch is ready for review. Local and OneDrive
containers are validated without a git push.
