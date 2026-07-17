---
name: initialize
description: Define a skills module's scope and organize its skills into a scalable area tree
resources:
  - okh://instructions/grilling.md
---

# Initialize a skills module

Build a cohesive, navigable skill collection. Do not default to one catch-all
module: module boundaries are part of the design.

1. **Establish the contract.** Read and apply the
   [grilling instructions](okh://instructions/grilling.md) to clarify the
   users, recurring work, capability areas, ownership, access, and sync lifecycle.
   Decide what belongs here and what belongs in another skills module.
2. **Choose module boundaries.** Use separate modules when skills have different
   audiences, owners, permissions, source containers, or release/sync lifecycles.
   Use folders only to group cohesive areas inside one module.
3. **Design the tree.** Group by stable capability area, with arbitrary-depth
   subgroups when needed. A group directory may have an `index.md` describing its
   purpose and direct children. A directory with `SKILL.md` is a leaf; every
   descendant is a bundled resource, never a child skill.
4. **Write `index.md`.** Record purpose, goals, in/out scope, module-boundary rules,
   the folder taxonomy, naming rules, and a top-level catalog. Keep catalogs
   progressive: root lists areas; area indexes list their direct children.
5. **Normalize skills.** Each leaf uses standard `SKILL.md` frontmatter (`name`,
   `description`) and discipline text. Keep `name` unique within this module; the
   same name may exist in another module. Preserve scripts, references, and
   templates inside their skill leaf.
6. **Verify.** Inspect the module, confirm every skill appears at its nested path,
   resolve representative skills with `run`, fix structural errors, then `sync`.

Completion requires a written scope contract, an intentional module boundary, a
navigable area tree, unique skill names within the module, and runnable leaves.
