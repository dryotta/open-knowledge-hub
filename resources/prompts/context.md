# OKH: context

**Task:** {{var:task}}

**Available targets:**
{{var:targets}}

<discipline name="context">

# Discipline: context

Assemble a compact, task-relevant working set from your containers before acting.
Do NOT dump whole modules into context.

1. Read the provided list of containers -> modules -> paths.
2. Enumerate what each relevant module actually contains: inspect the module
   ({ container, module }) to list its items. Start from the overview (knowledge/llmwiki:
   `index.md`; skills: the root `index.md` and its nested skill paths; memory: recent files;
   custom/tool modules: their task-relevant nested files).
   Skim; do not ingest wholesale. Never select an item from only its filename,
   directory, or recency — read enough content to verify direct task relevance.
   The inspect summary is enough to reject an obviously unrelated item; do not
   open clearly irrelevant candidates merely to confirm their rejection.
   Direct relevance means the stated task needs the item now, not that a generic
   procedure might become useful later. For example, do not select a debugging skill
   for an implementation task unless the task includes a failure to debug. Never put
   a conditional item in the selected working set merely because it could help "if"
   a different problem appears later; omit it until that problem is part of the task.
3. Select every item the task needs across ALL module types — knowledge alone is
   rarely enough:
   - knowledge concepts that inform the task,
   - skills whose procedure applies to the task, including skills that launch/run
     CLI tools — match the task to a skill by what it does, not just its name,
   - prior memory artifacts that are relevant,
   - utilities and references in custom/tool modules that directly support the task.
4. Produce the working set as a short list of bullet items grouped by module type. For each
   selected item give its item path (e.g. `<module>/<item>`) and one line on why
   it matters. Prefer paths/links over pasted content. Cite the complete listed
   item path, including its filename and extension; a module or directory path is
   not an item citation.
   Include only module types with at least one selected item. Never create a bullet
   for an excluded item, even to label it irrelevant or not applicable. A concise
   gap summary may say that no relevant item exists, but must not name or cite the
   rejected item.
5. Surface gaps: what the task needs that no module provides. Name only information
   required by the stated task; do not invent concrete libraries, algorithms, or
   generic best practices and present them as requirements. Describe missing coverage
   at the narrowest evidence-backed level instead of brainstorming likely subtopics.
   When only the broad task establishes a gap, state that gap once at the same broad
   level without examples or an invented checklist of subcategories.
   Honor requested output shape: if the caller asks for one broad gap statement,
   return one sentence under `## Gaps`, not a list.
   Put this separate from the selected working set under a `## Gaps` heading.

Output a concise brief the agent can act on — not a transcript of file contents.
Include the applicable skills by path, not just knowledge concepts.

</discipline>
