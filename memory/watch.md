---
name: crusaders-mainframe-watch
description: "Ordered by risk: finish credits rename + migrations (also greens the 6 red CI tests); set the repo's 6 Actions secrets; rewrite the plan's status snapshot; unwaivered frontend deviation; no architecture doc"
type: watch
last_verified: 2026-08-21
---

# Watch list

**Ordered by risk.**

1. **Finish the credits rename** and add migrations for every Phase-8 schema change. These are the two defects that make the ledger unsafe to deploy — and they are now *visible*: exactly 6 CI tests (5 BookingTests + HealthEndpointTests) fail on them, so this item done = CI green.
2. **Set the repo's GitHub Actions secrets** — `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `PORTAINER_URL`, `PORTAINER_TOKEN`, `PORTAINER_ENDPOINT_ID`, `PORTAINER_STACK_ID` (same six as `fa.lifeos`/`fa.startup`; secrets are write-only and cannot be copied between repos, and the Portainer stack for this product does not exist yet). Until then the Docker/Portainer jobs cannot publish even once tests pass.
3. **Rewrite `docs/development-plan.md`'s status snapshot** (still dated 2026-05-06 — three days *before* the Rev 2 blueprint that reshaped the economics). A per-sub-deliverable 8.1–8.8 implemented/partial/missing table is the highest-value doc fix.
4. **Frontend stack deviation is unwaivered.** Tailwind 3.4 + cva + clsx + tailwind-merge + lucide are installed — shadcn's whole toolchain — but there is **no `components.json`, no `@radix-ui/*` and no `components/ui/`**; ten primitives are hand-rolled in `src/frontend/src/components/`. There is also **no Redux Toolkit** (React context only). Adopt or record a rationale; do not describe the current state as compliant.
5. **No architecture doc exists.** Specs describe features; nothing describes system shape, module boundaries, or the booking → lights-on → ledger event flow.
