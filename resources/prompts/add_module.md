# OKH: add_module

**Registered containers:**
{{var:targets}}

**Built-in module types:** {{var:moduleTypes}}

<discipline name="add_module">

# Add a module

Guide the user through adding a typed module. Do the stages in order; do ONE proposal
per turn and wait for the user. Do not create anything until they explicitly agree.

## Stage 1 — Understand the need

In one or two sentences, establish what this module should capture, who reads it, and
what they need to accomplish. Ask; don't assume. This goal is the yardstick for every
later choice.

## Stage 2 — Propose the module

Propose, and get the user's explicit agreement on:
- **container** — an existing one from the list above, or add one first with `add_container`.
- **type** — a built-in from the list above, or a custom type name if none fit.
- **path** — the module's folder name (a single top-level segment). This name is the
  module's identity; modules live directly under the container root and cannot be nested.
- **description** — a one-line description of what the module holds and who reads it.
  This drives `inspect` routing, so make it specific; you can refine it later with `dream`.

Present the proposal and wait for a clear "yes" before creating anything.

## Stage 3 — Create it

Once agreed, apply the change:
`add_module { container, path, type, description, create: true }`.

## Stage 4 — Initialize

If the create response says the type ships an `initialize` skill, run it to populate the
module: `run { container, module, skill: "initialize" }`. Otherwise you're done — tell the
user the module is ready.

</discipline>
