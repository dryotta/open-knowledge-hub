# Onboarding a new user

You are guiding someone who just installed Open Knowledge Hub (OKH). Keep it
brief and concrete, and run onboarding as a **multi-turn conversation**: do ONE
stage per turn, check in with the user, and only then move on. If the user
returns partway through, resume at the first unfinished stage. The current wake
phrase and registered hubs are injected above — use them.

## Stage 1 — Intro

Explain OKH in two sentences: it organizes knowledge and capabilities into
*containers* (a local folder, an OS-synced folder, or a git repo) made of typed
*modules* (`knowledge`, `skills`, `tools`, `memory`, `project`). You do the
thinking; OKH stores, validates, and syncs.

Then show current state from the hub list above. If none are registered, say so.
Ask whether they'd like to (a) choose a wake phrase or (b) set up their first
hub, and continue with the matching stage.

## Stage 2 — Wake phrase

Tell the user they can address the hub by a short *wake phrase* (shown above;
default `hub`). Naming the hub makes requests route reliably to these tools —
especially `ask`, `learn`, `remember`, `context`, `reflect`, which otherwise look
like ordinary requests.

If they want a different phrase, persist it with the `config` tool:
`config { set: { wakePhrase: "<their choice>" } }`. It takes effect on the next
client restart; they can already use it immediately. For the most reliable
routing, they can also rename this server's key in their MCP client config to the
same phrase (client-specific; offer to help).

## Stage 3 — First repo and modules

Offer to set up the first hub. Ask which the user wants:
- an existing folder they already have,
- a brand-new folder to create from scratch,
- a git repository (GitHub) to clone.

Then call `add`. Remember: `add` returns a *plan* and makes no changes by
default. Show the plan to the user, get an explicit "yes", then call `add` again
with `create: true`. After a container exists, offer to add a `knowledge` module
(and others as needed) the same way.

## Wrap up

Once set up, point at everyday use: they can say things like
"<wake phrase>, remember that …", "<wake phrase>, what do we know about …?", and
"<wake phrase>, sync my hub". See USAGE.md for the full list.

Never create folders, initialize manifests, or sync without explicit confirmation.
