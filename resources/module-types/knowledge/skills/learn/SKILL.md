---
name: learn
description: Integrate new knowledge into this knowledge (OKF) module — only if it earns its place against the module's goals and scope.
resources:
  - okh://instructions/grilling.md
  - okh://instructions/okf/writer.md
---

Fold candidate knowledge into this `knowledge` module without letting it sprawl. Run these stages **in order**. The gate in Stage 2 is a hard stop.

## Stage 1 — Load the scope contract

Read the module's `index.md` and recover its **scope contract**: the **goals**, the **requirements / target questions**, and the **out-of-scope** list. Restate it back to the user in one or two lines. A module with **0 concepts can still have a full scope contract** in `index.md` — do not treat an empty concept list as "uninitialized", and do not run `initialize` on a module that already has a contract. Only if there is genuinely no written scope contract, stop and reconstruct one first — you cannot judge "worth remembering" without it.

## Stage 2 — The gate (default answer: NO)

A knowledge module earns its value from **restraint**. Decide which case the candidate falls into:

- **Serves a goal / answers a target question** → in scope. Proceed to Stage 3.
- **Out of scope, or trivial / generic / common knowledge that serves no goal** → **REJECT IT. Do not write, create, append, or edit any file.** Tell the user *why* in terms of the goals and out-of-scope list, and **stop here** — your entire response is the rejection.
- **Borderline — would only fit if the module's purpose grew** → do not decide unilaterally.
  Read and apply the [grilling instructions](okh://instructions/grilling.md) to negotiate
  scope: propose the smallest goal change that would justify it and get the user's explicit
  agreement, then re-run the gate. If it still doesn't serve a goal, reject it.

Never expand scope silently to make a fact fit. Scope changes are a user decision, made explicit in `index.md`.

## Stage 3 — Verify & ground (admitted candidates only)

Only knowledge that **passed the gate** reaches this stage.

- If it's a claim about **code**, verify it against the repository and cite the canonical **git origin URL pinned to a commit SHA** — never a relative path.
- If it's a **"why" / rationale** the code cannot prove, attribute it to the user, or flag it `⚠️ UNVERIFIED`.

`⚠️ UNVERIFIED` is **only** for grounding an *admitted* claim you could not verify. It is **never** a way to include knowledge that failed the Stage 2 gate.

## Stage 4 — Integrate

Author with the [OKF writer instructions](okh://instructions/okf/writer.md) for OKF format
and citation rules, then:

- Prefer **extending an existing concept** over adding a new doc; add a new concept only when it is genuinely distinct.
- Name the **target question** each addition serves. If you can't name one, it doesn't belong.
- Update `index.md` (scope contract, concept listing) and record the change in `log.md`.
- Keep types and citation style consistent with the rest of the module.

## Stage 5 — Re-test the gate

Confirm the addition is reachable from a target question, reads consistently, and **prune** anything it made redundant. Net additions should be the minimum needed.
