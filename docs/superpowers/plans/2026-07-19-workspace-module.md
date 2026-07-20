# Workspace Module Implementation Plan

**Goal:** Implement the approved client-managed workspace module, its seven-operation
MCP tool, reusable skills, durable project/run storage, and web management experience.

**Architecture:** A shared `WorkspaceService` owns deterministic reads and mutations
under the existing container mutation lock. The `workspace` loader exposes projects to
`inspect`; MCP and web adapters call the same service. Agent execution remains entirely
in the MCP client.

**Tech stack:** TypeScript (Node ESM), Zod, YAML, MCP SDK, Vitest, browser TypeScript,
and the existing loopback web server.

**Spec:** `docs/superpowers/specs/2026-07-17-workspace-module-design.md`

---

## File structure

Create:

- `src/workspaces/types.ts` — domain and operation types.
- `src/workspaces/markdown.ts` — README parsing, validation, and source-preserving
  section/frontmatter edits.
- `src/workspaces/events.ts` — CloudEvents batch parsing, atomic append, command replay,
  and run-state derivation.
- `src/workspaces/files.ts` — safe paths, ETags, atomic writes, tree validation/hashing,
  snapshots, and result publication.
- `src/workspaces/service.ts` — the seven operations and agent-reference resolution.
- `src/modules/loaders/workspace.ts` — project enumeration, overview, scaffold, and
  structural validation.
- `src/server/workspaceTool.ts` — one MCP tool adapter and response rendering.
- `resources/tool-meta/workspace.md` — tool metadata matching the schema.
- `resources/module-types/workspace/skills/{initialize,configure,create,coordinate}/SKILL.md`
  — client disciplines.
- `resources/module-types/workspace/README-skeleton.md` — editable starter.
- `resources/docs/workspaces.md` — product-facing workspace reference.
- `app/web/features/workspaces.ts` — workspace/project/attention UI.
- `app/web/routing.ts` — validated parameterized route matching.
- `test/workspaces.test.ts` — parser, loader, service, tool, and lifecycle coverage.

Modify:

- `src/config.ts` — expose the machine-local workspace staging root.
- `src/container/service.ts` — expose the existing shared mutation lock.
- `src/modules/{types,registry}.ts` — register the built-in workspace loader.
- `src/server/{toolSchemas,tools,index}.ts` — schema, registration, and service injection.
- `src/index.ts` — create and share `WorkspaceService` with MCP and web.
- `src/web/{types,server}.ts` — workspace HTTP reads/mutations.
- `app/web/{api,feature,main,styles.css}` — API client, routes, navigation, and UI.
- `resources/docs/{index,reference,usage,concepts}.md` — discoverability and routing.
- `test/{server,web-server}.test.ts` — MCP and web integration.

---

## Phase 1 — Domain, loader, and service

- [x] Add `workspace` to `BUILTIN_MODULE_TYPES` and register its loader.
- [x] Define strict operation/domain types and server safety limits.
- [x] Parse workspace/project README contracts, acceptance bullets, and lifecycle fields.
- [x] Patch only known frontmatter fields and Markdown sections while preserving unrelated
  content.
- [x] Implement safe module/project/run/staging paths and SHA-256 ETags.
- [x] Implement project `events.json` and workspace command replay as validated CloudEvents batches with contiguous
  sequence numbers and command replay checks.
- [x] Implement `list` and `get`, including attention, result history, and resume packages.
- [x] Implement workspace initialization and atomic project creation.
- [x] Resolve `agent`, `module/agent`, and `container/module/agent`; snapshot exact profiles.
- [x] Implement run start, staging allocation, snapshot hashes, criteria, and run IDs.
- [x] Implement paused/failed/cancelled reports and human guide/cancel interventions.
- [x] Validate and atomically publish successful results with path/file/total-size limits.
- [x] Implement project/workspace patches, archive/unarchive, and result restore.
- [x] Add focused parser/service/loader tests before moving to adapters.

## Phase 2 — MCP tool, skills, resources, and docs

- [x] Add one strict `workspace` tool schema with operation-specific service validation.
- [x] Render text, structured content, and existing module-file resource links.
- [x] Register the shared service in the MCP server dependency graph.
- [x] Add exact tool metadata and the four built-in workspace skills.
- [x] Ensure `coordinate` directs `get`/`start`, staging probe, frozen-profile delegation,
  `report`, and `sync` without running a model server-side.
- [x] Update reference, concepts, usage, and docs index.
- [x] Add MCP tests for all seven operations and invalid field/state combinations.

## Phase 3 — Web API and UX

- [x] Add same-origin workspace GET/POST endpoints over `WorkspaceService`.
- [x] Add route matching that decodes and validates path parameters without falling back
  silently.
- [x] Add Workspaces navigation and list/detail views.
- [x] Add project Overview, Activity, Result, and Settings views.
- [x] Add Needs attention guidance/cancellation and active-run cancellation messaging.
- [x] Add result history/file links/restore and archive/unarchive controls.
- [x] Keep Start/Continue/Resume absent from web because execution requires an MCP client.
- [x] Add API security, route, rendering, and mutation tests.

## Phase 4 — Validation and publication

- [x] Run targeted workspace, server, and web tests.
- [x] Run full typecheck, build, and test suites.
- [x] Review the complete diff for state, recovery, path, and concurrency defects.
- [x] Resolve high-confidence review findings.
- [x] Commit and push the implementation to the existing PR branch.
- [x] Update PR #46 to describe the implementation and verify remote checks.

---

## Required invariants

- Project status is only `active` or `archived`.
- One project has at most one active run.
- A paused run remains active until resumed, cancelled, failed, or succeeded.
- Snapshots, terminal events, and published result directories are immutable.
- Agent profiles are frozen at start; active runs never read live profiles.
- No Hub scheduler, task graph, model runner, transcript store, or approval state is added.
- Every unsafe path, stale ETag, command conflict, and invalid transition fails visibly.
- Web and MCP mutations call the same service and share the container mutation lock.
