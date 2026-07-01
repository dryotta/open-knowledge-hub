# MCP is deterministic tools + prompts over OKF; the client agent does all reasoning

open-knowledge-hub is an MCP server that manages a catalog of knowledge packs, where a
pack is an [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
bundle published to its own git repo (full repo or subfolder). We decided the server
exposes only **deterministic tools** (catalog CRUD, git clone/install/uninstall, status,
pull, commit, branch, PR) and **prompt/tool templates** that inject a vendored copy of the
OKF discipline (ask / learn / review-update / create) into the calling agent — the server
runs **no LLM of its own**. All intelligence (grilling, exploring, writing) happens in the
client agent, mirroring how the existing `okf-*` skills already work.

## Considered Options

- **Server-side LLM/sub-agents** (rejected): the MCP would answer/learn autonomously. Heavier,
  needs its own model credentials, duplicates the agent already on the other end of MCP, and
  breaks the "one place does the thinking" model.
- **Invent a new pack format** (rejected): OKF already defines a portable, git-native,
  scope-bounded markdown bundle and there is a working skill family for it.

## Consequences

- The OKF discipline text must be **vendored** into this repo so prompts are self-contained and
  don't depend on any external skills directory being present on the host.
- The discipline flows are exposed as **both** MCP prompts and equivalent tools (returning the
  same instruction text), because MCP client support for the prompts primitive is uneven.
