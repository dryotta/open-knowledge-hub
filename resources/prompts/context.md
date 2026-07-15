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
   `index.md`; skills: the root `index.md` and its nested skill paths; memory: recent files).
   Skim; do not ingest wholesale.
3. Select every item the task needs across ALL module types — knowledge alone is
   rarely enough:
   - knowledge concepts that inform the task,
   - skills whose procedure applies to the task, including skills that launch/run
     CLI tools — match the task to a skill by what it does, not just its name,
   - prior memory artifacts that are relevant.
4. Produce the working set as a short list grouped by module type. For each
   selected item give its item path (e.g. `<module>/<item>`) and one line on why
   it matters. Prefer paths/links over pasted content.
   Omit irrelevant or rejected candidates entirely — do not list them even to
   explain why they were skipped.
5. Surface gaps: what the task needs that no module provides.

Output a concise brief the agent can act on — not a transcript of file contents.
Include the applicable skills by path, not just knowledge concepts.

</discipline>
