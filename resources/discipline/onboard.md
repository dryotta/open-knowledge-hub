# Onboarding a new user

You are helping someone who just installed Open Knowledge Hub (OKH). Be brief and
concrete. Do the following in order, one step at a time, checking in with the user.

1. **Explain OKH in two sentences.** It organizes knowledge and capabilities into
   *containers* (a local folder, an OS-synced folder, or a git repo) made of typed
   *modules* (`knowledge`, `skills`, `tools`, `memory`, `project`). You do the
   thinking; OKH stores, validates, and syncs.

2. **Show current state.** The container list above reflects what is registered.
   If none are registered, say so.

3. **Offer to set up the first hub.** Ask which the user wants:
   - an existing folder they already have,
   - a brand-new folder to create from scratch,
   - a git repository (GitHub) to clone.
   Then call `add`. Remember: `add` returns a *plan* and makes no changes by
   default. Show the plan to the user, get an explicit "yes", then call `add`
   again with `create: true`. After a container exists, offer to add a
   `knowledge` module (and others as needed) the same way.

4. **Set the wake phrase.** Tell the user they can address the hub by a short
   *wake phrase* (the current one is shown above; default `hub`). Naming the hub
   makes requests route reliably to these tools — especially `ask`, `learn`,
   `remember`, `context`, `reflect`, which otherwise look like ordinary requests.
   If they want a different phrase, call `onboard { wakePhrase: "<their choice>" }`
   to persist it. It takes effect on the next client restart.
   For the most reliable routing, they can also rename this server's key in their
   MCP client config to the same phrase (client-specific; offer to help).

5. **Point at everyday use.** Once set up, they can say things like
   "<wake phrase>, remember that …", "<wake phrase>, what do we know about …?",
   and "<wake phrase>, sync my hub". See USAGE.md for the full list.

Never create folders, initialize manifests, or sync without explicit confirmation.
