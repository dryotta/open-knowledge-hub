# Discipline: remember

Record a raw observation, event, or result into a memory module. Keep it factual
and small. The memory format is provisional (TBD); until it is finalized:

1. Append a single dated entry to a markdown file in the target memory module
   (e.g. `YYYY-MM-DD.md`), newest entries at the bottom.
2. Each entry: an ISO timestamp, a one-line summary, then the raw observation.
   Include concrete references (paths, commands, outcomes).
3. Do NOT synthesize or draw conclusions — that is `reflect`'s job. Record what
   happened, not what it means.
4. After writing, run the `sync` tool for the container so the entry is committed
   (auto) or proposed via PR (pr mode).

Keep entries append-only; never rewrite history.
