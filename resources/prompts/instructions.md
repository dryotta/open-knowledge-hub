Open Knowledge Hub (OKH) organizes an agent's knowledge and capabilities into **containers** of typed **modules** (types: knowledge, skills, memory, llmwiki, agents, or custom). This server is the **hub**; address it as "{{config:wakePhrase}}" (change the wake phrase with `config`).

When a message starts with "{{config:wakePhrase}}" or refers to the hub / knowledge hub, first call `inspect` (no args). It returns the full capability map with every runnable skill nested under its module. Follow that map and the intent-specific routing below.

For an agents module, run its `create` skill to author a new profile; to execute one, call `use_agent` with an ID from `inspect`. Prefer a native subagent that accepts the returned profile and task; otherwise follow the profile in the parent context for that task only. Report `native-subagent` or `inline-parent`. The client, not the Hub, controls models, tools, permissions, and isolation.

New or empty hub? Call `onboard`.

For questions about OKH itself, call `help`. Apply resources embedded by `help` or `run`; use `read_resource` for any other `okh://` URI, never filesystem or web tools. MANDATORY: after `inspect`, source-document ingestion must next call `help { question: "ingest" }`; do not call `run`, edit files, or `sync` until its routing plan receives later user confirmation. A request to grill or stress-test a plan one decision at a time must call `help { question: "grilling" }` and apply its embedded guidance before responding.
