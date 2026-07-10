# OKH — `llmwiki` Module Type (Karpathy "LLM Wiki" pattern)

**Status:** Draft design (under review, rev. 2)
**Date:** 2026-07-10
**Relates to:** `2026-07-07-okh-module-system-redesign-design.md` (reserved `llmwiki` as a future built-in type "with no architectural change"), `2026-07-09-okh-ingest-skill-design.md` (shared `ingest` front-door), `docs/adr/0004-containers-of-typed-modules.md`

---

## 1. Summary

Add a new built-in module type, **`llmwiki`**: a living, interlinked wiki an agent
builds and maintains, optimized for **both human reading and agent knowledge**. It
realizes Andrej Karpathy's ["LLM Wiki"
pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) —
knowledge is *compiled once and kept current* as a persistent, compounding
artifact, rather than re-derived per query.

Each wiki is **scope-bounded**: its `index.md` declares which topics belong and
which do not, so a hub can hold many wikis for different topics and audiences.

**Pages use OKF** (Open Knowledge Format) by default — the same format as the
`knowledge` type. We do not invent a parallel page format. What makes `llmwiki`
distinct is its **operating model**, not its file format (§2).

The type follows OKH's invariants unchanged (ADR-0001, ADR-0004): **the server
runs no LLM and never acts**. Cognition ships as **vendored discipline skills** the
client agent runs; **discovery is deterministic** via an internal loader (§4).
Karpathy's `CLAUDE.md` "schema" is split into: universal wiki discipline (the
vendored skills) + per-wiki configuration (the module's `index.md` scope
contract).

### Goals

1. A domain-agnostic wiki type usable across many instances (personal, research,
   team playbook, codebase map, book companion, …).
2. Each wiki has an explicit **scope contract** (in/out-of-scope topics) — the rule
   for what belongs.
3. Pages are **human-readable and interlinked** (a real graph), and equally
   consumable by an agent as knowledge.
4. **Compounding**: ingesting a source touches many pages; good answers to queries
   are filed back as pages.
5. **Deterministic wiki-health** (orphans, dangling links) surfaced by the existing
   `inspect` tool with zero agent work; semantic health left to a `lint` skill.
6. Reuse existing substrate: **OKF** for content, **`okf-writer`** for authoring,
   the loader + vendored-skills + `run` machinery. **No new MCP tools.**

### Non-goals (YAGNI)

- **No new page/frontmatter format** — reuse OKF.
- **No server-side search index / embeddings / FTS DB** (lucasastorian's model; it
  breaks OKH's "server never acts"). At moderate scale `index.md` is the index, per
  Karpathy.
- **No Obsidian-specific artifacts** (`[[wikilinks]]`, Dataview) — OKF uses portable
  markdown links.
- **No new operational tool.** Everything routes through existing tools/flows.

---

## 2. Where `llmwiki` fits — same OKF substrate, different operating model

All three types below can hold markdown knowledge; `knowledge` and `llmwiki` both
use **OKF** and the shared **`okf-writer`** skill. The difference is *discipline and
audience*, not format:

| Type | Content | Operating model | Skills |
|------|---------|-----------------|--------|
| `knowledge` | OKF | **High-restraint**, **default-NO** gate — a concept must *earn its place*; minimal net additions; "a sprawling auto-generated wiki is the failure mode." Agent-facing. | `initialize`, `learn` |
| `memory` | dated markdown | Raw, append-only observations, later distilled. | `remember`, `reflect` |
| **`llmwiki`** | **OKF** | **Coverage within scope** — welcomes breadth on any in-scope topic; grows from ingests *and* queries (Karpathy's "touch 10–15 pages"); the connected graph is a health invariant; **human + agent** readable. | `initialize`, `write`, `lint` |

So `llmwiki` is *not* a new format and *not* the `knowledge` type re-skinned. It is a
distinct type whose **skills + loader encode a different discipline**: `knowledge`
optimizes for restraint and terse agent retrieval; `llmwiki` optimizes for a
browsable, compounding, connected wiki that both people and agents read. Both write
OKF, so a wiki can later be read by any OKF consumer, and shared authoring/citation
rules stay consistent across the hub.

---

## 3. On-disk format (OKF)

A `llmwiki` module is a folder with `.okh/module.yaml` (`type: llmwiki`) whose
content is an **OKF bundle**:

```
<module>/
  index.md          # OKF root index: scope contract + concept catalog + declared types + gen SHA
  log.md            # OKF update log (date-grouped, newest first)
  concepts/  entities/  syntheses/ ...   # groups chosen from a template at initialize; each has its own index.md
      kv-cache-efficiency.md             # an OKF concept doc
  sources/          # optional — only if the index.md `## Sources` retention policy says so (as in knowledge)
```

Reserved filenames (`index.md`, `log.md`) are not concepts — identical to OKF /
`knowledge`.

### 3.1 `index.md` — the OKF root index (contract + catalog)

Holds the *per-wiki* configuration (universal discipline lives in the skills). Uses
the OKF root-index shape (as `okf-writer` already generates), with the wiki framing:

- **Purpose** — one line.
- **Goals** — who reads it (humans *and* agents) and what they need. Stated first;
  the yardstick for every scope decision.
- **In scope / Out of scope** — the topic gate every page is judged against.
- **Structure** — the chosen template: group folders + the **concept `type`
  vocabulary** (declared, per OKF) + tag scheme.
- **Sources** — optional retention policy (identical to the `knowledge` convention;
  honored by the shared `ingest` skill). Default: don't retain.
- **Concept catalog** — progressive-disclosure listing grouped by folder, each
  `title — one-line description`. Read first when answering a query, then drill into
  pages (Karpathy's index-first retrieval; works to ~hundreds of pages, no RAG).
- **Generation commit SHA** — per `okf-writer`, so staleness of code-derived pages
  is detectable.

### 3.2 Page format — OKF concept docs

Each page is an OKF concept doc: YAML frontmatter (`type` required; `title`,
`description`, `tags`, `timestamp` recommended/optional) + a markdown body.
Authored with **`okf-writer`** (see §5.2), so:

- Structural markdown (headings, lists, tables, fenced code) preferred over prose —
  "aids both human reading and agent retrieval" (OKF-FORMAT). This already serves
  the human + agent audience; **no separate "every page needs a visual" mandate** —
  we defer to `okf-writer`'s rule that diagrams appear only when a question is
  inherently structural/temporal, never decoratively.
- No invented `created`/`updated`/`sources` keys — use OKF `timestamp` + the
  `# Citations` section.

### 3.3 Links & the graph (OKF cross-links)

- **OKF bundle-relative links** between concepts: `[KV Cache](/concepts/kv-cache-efficiency.md)`
  (absolute-from-bundle-root preferred; stable when files move within a subdir).
- **No-orphan discipline** (the wiki add): every page links to at least one other.
  OKF *tolerates* broken links as "not-yet-written knowledge" — the `write`/`lint`
  skills use that: a link to a not-yet-created page is a to-do, surfaced by health.
- **Backlinks are computed by the loader** (§4), not hand-maintained per page.

### 3.4 Grounding — OKF citation discipline (no separate "stance")

*(Replaces the rev-1 "grounding stance", which was confusing.)* Grounding is just
OKF's existing citation discipline, reused via `okf-writer`:

- Every non-trivial claim carries a citation under `# Citations` (a repo `path` /
  `path:line`, a source doc, or a URL).
- A "why"/rationale that a source can't prove is resolved by grilling the user, or
  written with a leading `> ⚠️ UNVERIFIED:` blockquote.
- Where knowledge genuinely comes from synthesis or the user (e.g. a team-playbook
  wiki), that is captured the same way `knowledge` already handles it — attribute to
  the user or flag unverified. **The user never has to pick a "citation mode."**

### 3.5 `log.md`

OKF update log — date-grouped, newest first, ISO `YYYY-MM-DD` headings:

```markdown
# Update Log

## 2026-07-10
* **Ingest** (KV Cache paper): created [KV Cache Efficiency](/concepts/kv-cache-efficiency.md); updated [Transformer](/entities/transformer.md). Flagged contradiction with earlier memory-budget claim.
* **Lint**: fixed 1 dangling link; 1 orphan remains (see notes).
```

---

## 4. The loader — internal, deterministic, **not a tool**

**What a loader is (answering the review question).** A *loader* is internal
TypeScript in the MCP server (`src/modules/loaders/*.ts`) — the deterministic,
no-LLM half of a module type. It is **not** an MCP tool and is never called by the
agent directly. Each type has one; the existing tools/flows call it:

- `inspect` → `enumerate` (list items) + `overview` + (new) `health`
- `add_module` → `scaffold` (write the skeleton)
- `ask` → `overview` (the entry point the forked sub-agent reads first)

So `llmwiki` adds **no new tools**. Its wiki-health report simply appears inside the
existing `inspect` tool's output.

`llmwikiLoader` reuses the `knowledge` loader's OKF logic (shared helper) for
`enumerate` / `overview` / `scaffold`, and adds `health`:

- **`enumerate(moduleRoot)`** — walk `*.md` (skip `index.md`/`log.md`), read OKF
  frontmatter → `Item { path, title, description, type }`. (Same as knowledge.)
- **`overview(moduleRoot)`** — return `index.md`; fallback to a generated
  folder-grouped listing.
- **`scaffold(moduleRoot)`** — write `index.md` (OKF root-index skeleton, wiki
  framing) + `log.md`. Content group folders are created by `initialize` per the
  chosen template (mirrors the knowledge loader, which scaffolds only `index.md`).
- **`health(moduleRoot)` — new, optional on the `Loader` interface.** Purely
  structural graph analysis over OKF cross-links:
  - **orphans** — pages with no inbound link (excluding `index.md`/`log.md`).
  - **dangling links** — links whose target file does not exist (OKF-tolerated, but
    surfaced as a to-do).
  - **uncataloged** — pages not listed in `index.md`.
  - **missing-`type`** — concept docs whose frontmatter lacks the required OKF `type`.

This is the OKH-flavored, DB-free half of lucasastorian's `lint`: the *structural*
checks a machine can do with certainty. *Semantic* checks (contradictions, stale
claims, missing cross-refs) stay in the `lint` **skill** (agent judgment). Clean
split: deterministic structure in the loader, judgment in the skill.

### 4.1 Integration touchpoints (small, well-bounded)

- `Loader` (`src/modules/types.ts`) gains optional `health?(): Promise<WikiHealth>`.
- `BUILTIN_MODULE_TYPES` (`src/modules/types.ts:2`) gains `"llmwiki"`.
- `LOADERS` (`src/modules/registry.ts`) registers `llmwiki: llmwikiLoader`.
- `InspectResult` `kind:"module"` (`src/container/service.ts:207`) gains optional
  `health`; `inspect()` calls `getLoader(type).health?.(moduleRoot)`.
- `formatInspect` (`src/server/tools.ts`) renders a "Wiki health" block when present.
- Other loaders are unaffected (the method is optional).

Result: `inspect { container, module }` on a wiki instantly shows structural health;
the `lint` skill layers judgment on top.

---

## 5. Vendored skills (`resources/module-types/llmwiki/skills/`)

Cognition ships as vendored skills, run via the existing `run` flow. They map
Karpathy's operations (setup / Ingest / Query / Lint) and reuse the shared
`grilling` and `okf-writer` skills — the same building blocks `knowledge` uses.

> **Frontmatter caveat:** each `SKILL.md` `description` must not contain an unquoted
> `": "` (colon-space) — it breaks YAML parsing and silently drops the skill from
> discovery. Use an em-dash or quote the value.

### 5.1 `initialize` — shape a new wiki

Reuses shared **`grilling`** (one question at a time). Establishes and writes the
scope contract into `index.md`:

1. **Purpose, Goals, In/Out-of-scope** topics.
2. **Structure — from a menu of templates** (the reviewer's request): present
   archetypes, let the user pick and customize the group folders + OKF `type`
   vocabulary:
   - **Encyclopedia** (Karpathy default): `concepts/`, `entities/`, `summaries/`,
     `syntheses/`
   - **Diátaxis docs**: `tutorials/`, `how-to/`, `reference/`, `explanation/`
   - **Topic tree**: nested topic folders, each with its own `index.md`
   - **Codebase map**: `components/`, `flows/`, `decisions/`, `glossary/`
   - **Custom**: user-declared folders/types
3. **Tag scheme** + optional **Sources retention** policy (inherited from OKF /
   knowledge; default off).

Then **build to the contract** (mirrors `knowledge`'s `initialize`):
- **Empty wiki (common case):** write the contract to `index.md`, create the
  declared group folders (each with a stub `index.md`), seed `log.md`. Do **not**
  invent content — pages accrue via `write`.
- **Existing folder of content:** review against scope; keep/organize, cut
  out-of-scope, fix unverifiable claims, note gaps for `write`.

### 5.2 `write` — integrate material into the wiki (Karpathy "Ingest")

The type-specific filing skill, invoked directly or routed to by the shared
`ingest` front-door (§6.1). **Authoring is delegated to the shared `okf-writer`
skill** (OKF format + the citation discipline of §3.4) — exactly as `knowledge`'s
`learn` does. What `write` adds on top is the *wiki operating model*:

1. Load the scope contract from `index.md`; restate goals + in/out-of-scope.
2. **Scope gate — coverage-oriented** (not knowledge's default-NO restraint): admit
   anything within the declared topics; for out-of-scope material negotiate via
   `grilling` (smallest scope change, explicit agreement) or reject — **never
   silently expand scope**.
3. **Integrate, touching many pages** (Karpathy's 10–15): prefer updating existing
   concepts over new ones; create per the declared structure/types; author
   **bidirectional cross-links**; **flag contradictions** rather than silently
   overwriting.
4. **Update `index.md`** (catalog + declared types) and **append `log.md`**.
5. Re-check: page reachable from the catalog, no orphan; `inspect` health clean.

### 5.3 `lint` — health sweep (semantic, builds on the loader)

1. Run `inspect { container, module }` to get the deterministic structural health
   block (orphans, dangling links, uncataloged, missing-`type`).
2. Read the wiki for **judgment** issues: contradictions between pages, stale claims
   newer material superseded, concepts mentioned but lacking a page, missing
   cross-references, thin pages, data gaps.
3. **Fix** mechanical issues (add links, catalog entries, frontmatter); **report**
   issues needing human judgment; **suggest** new questions/sources to pursue.
4. Append a `## <date>` `Lint` entry to `log.md`.

### 5.4 Query — handled by the global `ask` flow (extended)

Query stays the single `ask` entry point (no per-type query skill). The `ask`
discipline (`resources/prompts/ask.md`) already forks a sub-agent that reads a
module's `index.md` first — OKF navigation works for a wiki as-is. We add one line:
when a wiki query produces durable synthesis, **file it back as a new OKF page** via
the `write` skill (Karpathy's compounding).

### 5.5 Skill naming (open decision)

Proposed: **`initialize`, `write`, `lint`**. `write` vs `learn` (used by knowledge;
reusing it would blur the restraint-vs-coverage distinction) vs `file`/`ingest`
(`ingest` clashes with the shared skill name). No new `wiki-writer` skill —
authoring reuses the shared `okf-writer` (resolved).

---

## 6. Wiring & docs

### 6.1 Extend the shared `ingest` front-door

`resources/shared/skills/ingest/SKILL.md` Stage 5 routes source candidates to the
target type's skill. Add the `llmwiki` route:

- `knowledge` → `run { … skill: "learn" }`
- `memory` → `run { … skill: "remember" }`
- **`llmwiki` → `run { … skill: "write" }`**  *(new)*

Its `## Sources` retention handling already applies to any type whose `index.md`
declares a policy, so a wiki that retains sources gets it for free.

### 6.2 Extend `ask` navigation

`resources/prompts/ask.md` names per-type entry points ("knowledge: index.md; …").
Add: "llmwiki: index.md (OKF root index), then follow cross-links; file durable
answers back with the wiki's `write` skill."

### 6.3 `add_module` — no change needed

`add_module` already surfaces `initialize` for any type that ships one
(`src/server/tools.ts:201`), so onboarding a new wiki works with no extra wiring.

### 6.4 Resources to author

- `resources/module-types/llmwiki/index-skeleton.md` — OKF root-index skeleton, wiki
  framing (contract + empty catalog).
- `resources/module-types/llmwiki/skills/initialize/SKILL.md`
- `resources/module-types/llmwiki/skills/write/SKILL.md`
- `resources/module-types/llmwiki/skills/lint/SKILL.md`
  (`log.md` seed inlined in `scaffold` or a small skeleton file.)

### 6.5 Docs

- `README.md` — module-types table + "MCP surface": add `llmwiki` and its skills.
- Optional short ADR `docs/adr/000X-llmwiki-module-type.md`: Karpathy pattern over
  OKF, realized as discipline + deterministic loader; distinct from knowledge by
  operating model; no server index; no new tools.

---

## 7. Testing & verification

- **Unit (`test/`, Vitest):** loader `enumerate`/`overview`/`scaffold`/`health`
  against a temp OKF wiki with orphan + dangling-link + uncataloged + missing-`type`
  fixtures; vendored-skill discoverability (`llmwiki` exposes
  `initialize`/`write`/`lint`); `add_module` scaffolds + points at `initialize`;
  `inspect` renders the health block.
- **Eval (`eval/scenarios/*.yaml`):** initialize a wiki (grill + template menu +
  scope contract); `write` touching multiple pages with link maintenance; `lint`
  surfacing an orphan; `ask` navigating index→pages and filing an answer back.
- **Commands:** `npm run build`, `npm run typecheck`, `npm test`; eval:
  `npm run typecheck:eval`, `npm run test:eval`, and full `npm run eval` (a change of
  this size warrants full e2e eval).

---

## 8. Open decisions for the reviewer

1. **Skill names** — `initialize` / `write` / `lint` (§5.5)? Prefer `learn`/`file`
   over `write`?
2. **Default structure templates** — is the §5.1 menu (Encyclopedia / Diátaxis /
   Topic tree / Codebase map / Custom) the right starter set?
3. **ADR** — add `docs/adr/000X-llmwiki-module-type.md`, or is this spec enough?
4. **Loader code reuse** — factor a shared OKF loader helper used by both `knowledge`
   and `llmwiki`, or copy the small enumerate/overview logic? (Leaning: shared
   helper.)
