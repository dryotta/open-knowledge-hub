── Routing & usage ────────────────────────────────────────────────

**Effective skills** for a module = its **module type skills** (listed above,
keyed by type) minus any `overrides`, plus its own `+local` skills. Local skills
override a same-named module type skill.

**Routing gates — run the flow BEFORE any deterministic write:**
- **learn / teach / add durable knowledge** → `run { container, module, skill: "learn" }`
  on a knowledge module. Do not substitute a memory module's `remember`.
- **remember an observation, reminder, commitment, or task** → `run { container, module, skill: "remember" }`.
  Never call `todos` first.
- **any other natural-language todo change** → `run { container, module, skill: "todo" }`.
- Call `todos` directly only to read / list / filter todos, or after the active
  memory skill directs the deterministic mutation.

**Surfaces:**
- **Operational tools** act directly: `inspect`, `add_container`, `add_module`, `sync`, `config`, `todos`.
- **Flows** return discipline text for you to follow — they do not read or write on
  their own: `ask`, `context`, `run`, `onboard`.
- `add_container` and `add_module` preview until you re-call with `create: true`.

Apply ordinary writes immediately, then `sync`. For a container in **shared** mode,
`sync` pushes the configured branch; use the `publish-pr` action when ready.
