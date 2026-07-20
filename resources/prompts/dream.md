# Modules to consolidate
{{var:targets}}

<instructions name="dream">

# Dream — consolidate module descriptions

A module's manifest `description` is what `inspect` shows an agent that is deciding **where a
piece of work belongs**. If it is stale, empty, or vague, routing degrades. This is the
maintenance pass that reconciles each module's description with what the module has actually
become, reading from its `index.md` overview and writing a crisp one-liner back.

OKH runs no model and never reads files — the reading and the judgement are **yours**. OKH only
persists the result: you write the description through `config { container, module, set: { description } }`,
never by hand-editing `module.yaml`. Run the stages in order, once per target module listed above.

## Stage 1 — Read the module's current state

For each target module:

- Read its **overview** — `inspect { container, module }` includes `index.md`, or read
  `index.md` directly. This is the ground truth for what the module holds, its scope contract,
  and who reads it.
- Note the module's **current description** (shown in the target list and in `inspect`). Treat
  an empty description as a gap to fill, not as intentional.

Do not guess from the folder name alone. If a module has no `index.md` and no items, it is
effectively empty — say so in your report and skip it rather than inventing a description.

## Stage 2 — Draft a routing-quality description

Write **one line** (aim for a single sentence, ~10–20 words) that answers: *what does this module
hold, and what kind of question or work should be routed here?* Good descriptions are specific and
disambiguating — they name the subject matter and, where it helps, the boundary against sibling
modules.

- Prefer the vocabulary the `index.md` already uses (concept names, scope contract).
- Lead with the subject, not with "A module that…".
- If the module declares a scope contract, make the description consistent with it — surface any
  contradiction rather than papering over it.

Avoid: filler ("various notes", "misc"), the module type as the whole description ("a knowledge
module"), or copying the folder name back verbatim.

## Stage 3 — Confirm changes that meaningfully shift meaning

If your draft only sharpens wording, apply it. If it **changes what the module claims to be
about** — narrowing, broadening, or redefining scope — present the before/after to the user and
get a "yes" first. Consolidation should never silently redraw a module's boundaries.

## Stage 4 — Persist deterministically

For each accepted description, write it:

`config { container, module, set: { description } }`

This updates the module manifest atomically and drops any legacy fields. Do not edit `module.yaml`
directly.

## Stage 5 — Report

Summarize the pass: modules reviewed; descriptions updated (before → after); modules left
unchanged; empty/uninitialized modules skipped; and any scope contradictions you surfaced.

## Completion criterion

- Every target module was read from its `index.md`/items, not guessed from its folder name.
- Every module that holds content has a specific, routing-useful one-line description persisted
  through `config`.
- Descriptions that redefined a module's scope were confirmed with the user before writing.
- Empty or uninitialized modules were reported, not given invented descriptions.

</instructions>

{{prompt:partials/write-policy.md}}
