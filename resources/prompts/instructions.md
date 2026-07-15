Open Knowledge Hub (OKH) manages containers (folders, OS-synced folders, or git repos) made of typed modules: knowledge, skills, memory, and llmwiki.

**Routing gates:**
- If the user asks to **learn**, teach, or add durable knowledge, target a knowledge
  module and first call `run { container, module, skill: "learn", input? }`. Do not
  substitute a memory module's `remember` skill.
- If the user explicitly asks to **remember** an observation, reminder, commitment, or task, you MUST first call `run { container, module, skill: "remember", input? }`. Never call `todos` first.
- For any other natural-language todo change, you MUST first call `run { container, module, skill: "todo", input? }`.
- Call `todos` directly only to read/list/filter todos, or after the active memory skill directs the deterministic mutation.

Operational tools act directly: `inspect`, `add_container`, `add_module`, `sync`, `config`, and `todos`. Flows (`ask`, `context`, `run`, `onboard`) return discipline text for you to follow; they do not read or write on their own. Every deterministic todo operation still goes through `todos`.

Start with `onboard` for first-run setup. `add_container` previews and needs `create:true`; `add_module` returns a guided workflow and applies on `create:true` after you propose it to the user.

Address this hub as "{{config:wakePhrase}}". When a message starts with "{{config:wakePhrase}}" or mentions the hub/knowledge hub, use these tools. Apply ordinary writes immediately without confirmation, then `sync`; for shared mode, use `publish-pr` when ready.
