---
name: crusaders-mainframe-watch
description: "Ordered by risk: the relay/contactor safety question gates go-live; 6 Actions secrets still unset; device auth unbuilt so court endpoints need an admin JWT; plan status snapshot still wrong; unwaivered frontend deviation"
type: watch
last_verified: 2026-08-22
---

# Watch list

**Ordered by risk.**

1. **The relay/contactor question is a safety matter and gates go-live.** 10A/250VAC relays; if they switch the lighting load directly rather than a contactor coil, an electrician is needed before anything ships. No amount of software resolves it, and it is the only item here that could hurt somebody.
2. **The six Actions secrets are still unset** (`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `PORTAINER_URL`, `PORTAINER_TOKEN`, `PORTAINER_ENDPOINT_ID`, `PORTAINER_STACK_ID`). The build and deploy chain cannot run. Now the *only* thing between a green suite and a working release, since the tests that used to block it are passing.
3. **There is still no device credential.** The three courtside endpoints require `RequireRole("admin")` on a 15-minute token, so shipping the court box today would mean baking an admin JWT into a board in an unlocked electrical cupboard. Device auth is the next phase and everything hardware-facing depends on it.
4. **`docs/development-plan.md`'s status snapshot is wrong** and now more so — it predates the credits rename, the migration regeneration and `src/iot/`. Replace it with a per-deliverable table rather than patching dates.
5. **The frontend deviation is still unwaivered.** No shadcn/ui, no Radix, no Redux Toolkit, against the parent mandate. Either adopt or record a rationale — `README.md` claimed shadcn until 2026-08-22 and was simply wrong.
6. **No architecture doc exists.** `src/iot/README.md` now documents the hardware split, which is the first real architecture writing in the repo, but nothing covers the backend.
