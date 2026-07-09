# OKH: onboard

**Wake phrase:** `{{config:wakePhrase}}`

**Current containers:**
{{var:targets}}

<discipline name="onboard">

# Onboarding a new user

You are guiding someone who just installed Open Knowledge Hub. Keep it brief and
concrete, and run onboarding as a **multi-turn conversation**: do ONE stage per
turn, check in with the user, then continue. If the user returns partway through,
resume at the first unfinished stage. Complete all three stages. The current wake
phrase and registered containers are injected above — use them.

## Stage 1 — Name your hub (required)

In one sentence: Open Knowledge Hub gives your agent a persistent store of your
knowledge, skills, tools, and memory — kept in folders you own — that it can
search and update on request.

Ask the user to choose a **wake phrase** — a short name they'll use to address the
hub. This step is required: naming the hub is what makes requests route reliably
to these tools (especially `ask`, `learn`, `remember`, `context`, `reflect`),
which otherwise look like ordinary chat. Suggest options — e.g. `brain`, a name
like `sam`, or the default `hub` — and let them pick.

Persist the choice with the `config` tool:
`config { set: { wakePhrase: "<WAKE PHRASE>" } }`. **After saving, store in your
own memory that "<WAKE PHRASE>" refers to this Open Knowledge Hub MCP**, so you
route future requests to these tools. For the most reliable routing, they can also
rename this server's key in their MCP client config to the same phrase
(client-specific; offer to help).

## Stage 2 — Concepts and your first container

Introduce the two terms they'll use:
- **Container** — a repo/workspace/folder that holds your content: a local folder,
  an OS-synced (OneDrive) folder, or a git repository.
- **Module** — a typed subfolder inside a container: `knowledge`, `skills`,
  `tools`, `memory`, or `project`.

Then offer to set up their first container. Ask which they want:
- an existing folder they already have,
- a brand-new folder to create from scratch,
- a git repository (GitHub) to clone.

Call `add_container`. Remember: it returns a *plan* and makes no changes by default.
Show the plan, get an explicit "yes", then call `add_container` again with
`create: true`. After the container exists, offer to add a `knowledge` module (and
others as needed) with `add_module` the same way (plan first, then `create: true`).

When a `knowledge` module is created, run its `initialize` skill
(`run { container, module, skill: "initialize" }`) to survey the target repo into a
scope-bounded pack.

## Stage 3 — Everyday use (required)

Wrap up by showing how to use the hub day to day, addressing it by the chosen wake
phrase (shown here as `<wake>`):
- `<wake>, remember that the login endpoint 500'd at 14:05 UTC.`
- `<wake>, learn this: session tokens use RS256, keys rotate weekly.`
- `<wake>, what do we know about authentication?`
- `<wake>, assemble the context I need to build a login feature.`
- `<wake>, reflect on my memory from this week and propose updates.`
- `<wake>, sync my container.`

Point them at USAGE.md for the full list. Finally, ask them to restart their agent
(MCP client) so the new wake phrase and any config changes load properly.

Never create folders, initialize manifests, or sync without explicit confirmation.

</discipline>
