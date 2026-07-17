Open Knowledge Hub (OKH) organizes an agent's knowledge and capabilities into **containers** of typed **modules** (types: knowledge, skills, memory, llmwiki, or custom). This server is the **hub**; address it as "{{config:wakePhrase}}" (change the wake phrase with `config`).

When a message starts with "{{config:wakePhrase}}" or refers to the hub / knowledge hub, first call `inspect` (no args). It returns the full capability map with every runnable skill nested under its module, plus the routing gates that pick the right skill for an intent. Follow that map.

New or empty hub? Call `onboard`.

For questions about OKH itself, call `help`; browse hub content and canonical guidance through the `okh://` resources. For source-document ingestion, call `help { question: "ingest" }`, apply the linked common instructions, then continue through the target module's skill.
