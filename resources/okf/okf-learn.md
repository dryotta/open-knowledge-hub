---
name: okf-learn
description: Learn a new piece of knowledge into an existing OKF knowledge pack — but only if it earns its place against the pack's goals and scope.
disable-model-invocation: true
---

# OKF Learn

**Fold new knowledge into an existing *knowledge pack*** (an
[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) bundle produced by
`okf-new-from-repo`) without letting it sprawl. The candidate knowledge might come from the user,
from something newly discovered in the repository, or from a question the pack failed to answer.

The default answer to "should this go in the pack?" is **no**. A knowledge pack earns its value
from restraint: it answers an agreed set of target questions in service of explicit goals, and
deliberately excludes everything else. New knowledge is admitted **only** when it measurably
serves a goal — or when the user decides the goals themselves should grow. This skill is the
gatekeeper for that decision.

## Workflow

Run these stages in order.

### Stage 1 — Load the scope contract

Read the bundle root `index.md` and recover its **scope contract**: the **goals**, the
**target questions**, and the **out-of-scope** list. Everything downstream is judged against this
contract, so restate it back to the user in one or two lines before deciding anything. If the pack
has no written scope contract, stop and reconstruct one first (that's `okf-new-from-repo`
territory) — you cannot judge "worth remembering" without it.

### Stage 2 — Evaluate the candidate (the gate)

For the new knowledge, decide which case it falls into and act accordingly:

- **Serves a goal / answers a target question** → it's in scope. Proceed to Stage 3.
- **Out of scope, doesn't serve any goal** → reject it. Tell the user *why* in terms of the
  goals and out-of-scope list, and stop. Do not quietly add it. (If it's a recurring miss, note
  it — it may be evidence the scope should change, below.)
- **Borderline, or would only fit if the pack's purpose grew** → do **not** decide unilaterally.
  Run a short `/grilling` pass to **iterate with the user on the scope contract**:
  - Would admitting this knowledge require a **new or widened goal**? If so, propose the smallest
    goal change that would justify it, and the target question(s) it adds.
  - Does it instead reveal a goal or boundary that was mis-stated? Tighten or correct it.
  - Keep goals and scope **concise, consistent, and tight**: every goal justifies its questions,
    no question escapes a goal, and the out-of-scope list still has no overlap with what's in.
  Only after the user agrees the revised contract, re-run the gate. If the knowledge now serves a
  goal, proceed; otherwise reject it and record the revised contract anyway.

Never expand scope silently to make a fact fit. Scope changes are a user decision, made explicit
in `index.md`.

### Stage 3 — Verify & ground

Knowledge enters the pack only if it can be trusted:

- If it's a claim about the **code**, verify it against the repository (use `/explore-repo` for
  anything you must trace), and cite it. Citations follow the **same rule as the rest of the
  pack**: link to the canonical **git origin URL** pinned to a commit SHA — never a relative path
  (see `okf-new-from-repo` §Citations and `okf-writer`).
- If it's a **"why" / rationale** the code cannot prove, it came from the user — attribute it to
  the grilling session, or flag it `⚠️ UNVERIFIED`. Never assert an unverifiable claim as fact.

### Stage 4 — Integrate (okf-writer)

Use the `/okf-writer` discipline to write the knowledge in:

- **Prefer extending an existing concept** over creating a new doc. Add a new concept only when
  the knowledge is genuinely a distinct concept that an existing doc shouldn't absorb.
- Name the **target question** each addition serves (an existing one, or a newly agreed one from
  Stage 2). If you can't name it, it doesn't belong.
- Update the root `index.md`: the scope contract (including any agreed goal/scope changes), the
  concept listing, and the generation/update SHA. Record the change in `log.md` (what was added
  or changed, and why).
- Keep types and citation style consistent with the existing bundle.

### Stage 5 — Re-test the gate

Confirm the addition didn't loosen the pack:

- The new content is reachable from a target question and reads consistently with the rest.
- **Prune** anything the addition made redundant. Net additions should be the minimum needed.
- If scope changed, optionally re-run the reader-test (`okf-new-from-repo` §Stage 5) so a fresh
  reader can still answer every target question — including any newly added one.

## Completion criterion

- The candidate knowledge was judged against the pack's **goals + target questions + out-of-scope**,
  and either admitted because it serves a goal, or rejected with a goal-based reason.
- Any scope change was an **explicit, user-agreed** edit to the contract in `index.md` — never a
  silent expansion — and the revised goals/scope remain concise, consistent, and tight.
- Every admitted claim is cited to the repo's **git origin URL** (pinned to a commit SHA),
  attributed to grilling, or flagged `⚠️ UNVERIFIED`.
- The bundle stays OKF-conformant; `index.md` and `log.md` reflect the change; nothing unused
  survives.
