---
title: Open Knowledge Hub documentation
description: Canonical documentation for installing, using, extending, and developing Open Knowledge Hub.
---

# Open Knowledge Hub

Open Knowledge Hub (OKH) is an MCP server that organizes agent-accessible knowledge
and capabilities into **containers** of typed **modules**. OKH runs no model: it
provides deterministic tools, read-only resources, and instructions text; the client
agent performs reasoning and edits.

This directory is the single source of truth for current OKH behavior:

| Document | Use it for |
| --- | --- |
| [Getting started](okh://docs/getting-started.md) | Prerequisites, installation, and onboarding |
| [Concepts and routing](okh://docs/concepts.md) | Hub, container, module, skill, resource, and intent routing |
| [Usage](okh://docs/usage.md) | Natural-language and tool-call examples |
| [Workspaces and projects](okh://docs/workspaces.md) | Reusable workflows, durable projects, client-executed runs, interventions, and results |
| [Reference](okh://docs/reference.md) | Tools, resources, built-in skills, manifests, and variables |
| [Agent templates](okh://docs/agent-templates.md) | Research-backed recipes for creating focused Copilot agents |
| [Resource architecture](okh://docs/resources.md) | MCP resource design, security, and provider extension |
| [Development](okh://docs/development.md) | Build, test, inspect, and repository architecture |

Call `help` with a question to receive the most relevant documents as bounded embedded
resources plus canonical links. Full MCP clients can browse `okh://docs/` through
`resources/read`; agents on tool-only hosts use `read_resource`.
