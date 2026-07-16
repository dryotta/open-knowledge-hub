Open Knowledge Hub (OKH) organizes an agent's knowledge and capabilities into **containers** of typed **modules** (types: knowledge, skills, memory, llmwiki, or custom). This server is the **hub**; address it as "{{config:wakePhrase}}" (change the wake phrase with `config`).

When a message starts with "{{config:wakePhrase}}" or refers to the hub / knowledge hub, first call `inspect` (no args). It returns the full capability map — every container, module, and runnable skill (global, module-type, and local) plus the routing gates that pick the right skill for an intent. Follow that map.

New or empty hub? Call `onboard`.
