---
name: crusaders-mainframe-watch
description: "Ordered by risk: create repo + push; finish credits rename + migrations; rewrite the plan's status snapshot; unwaivered frontend deviation; no architecture doc"
type: watch
last_verified: 2026-07-24
---

# Watch list

**Ordered by risk.**

1. **Create the GitHub repo and push.** History exists locally but has no off-machine copy; a disk loss still loses everything. Then get the first green CI run — the deploy chain is written and completely unexercised.
2. **Finish the credits rename** and add migrations for every Phase-8 schema change. These are the two defects that make the ledger unsafe to deploy.
3. **Rewrite `docs/development-plan.md`'s status snapshot** (still dated 2026-05-06 — three days *before* the Rev 2 blueprint that reshaped the economics). A per-sub-deliverable 8.1–8.8 implemented/partial/missing table is the highest-value doc fix.
4. **Frontend stack deviation is unwaivered.** Tailwind 3.4 + cva + clsx + tailwind-merge + lucide are installed — shadcn's whole toolchain — but there is **no `components.json`, no `@radix-ui/*` and no `components/ui/`**; ten primitives are hand-rolled in `src/frontend/src/components/`. There is also **no Redux Toolkit** (React context only). Adopt or record a rationale; do not describe the current state as compliant.
5. **No architecture doc exists.** Specs describe features; nothing describes system shape, module boundaries, or the booking → lights-on → ledger event flow.
6. Fixed 2026-07-24: `docs/specs/biometric-abstraction.md` pointed at `../client-blueprints/…` (a directory that does not exist); the blueprint was always filed correctly at `./client-blueprints/` and the link now resolves. The orphaned `modal-fixed.png` was moved into `docs/screenshots/`.
