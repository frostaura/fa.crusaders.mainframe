---
name: crusaders-mainframe-watch
description: "Ordered by risk: the relay/contactor safety question gates go-live; 6 Actions secrets still unset so the release chain is unproven; committee sign-off on charge-at-booking; the first-ESP-flash DIP position; the firmware signing key does not exist; unwaivered frontend deviation"
type: watch
last_verified: 2026-08-23
---

# Watch list

**Ordered by risk.** Items 1–5 are the go-live blockers and are expanded, with the
consequence of skipping each, in [`docs/go-live-checklist.md`](../docs/go-live-checklist.md).

1. **The relay/contactor question is a safety matter and gates go-live.** 10A/250VAC relays;
   if they switch the lighting load directly rather than a contactor coil, an electrician is
   needed before anything ships. No amount of software resolves it, and it is the only item
   here that could hurt somebody. A welded contact is a court whose lights **cannot be
   switched off by anything** — the box has no readback and cannot even detect it.
2. **The six Actions secrets are still unset** (`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`,
   `PORTAINER_URL`, `PORTAINER_API_KEY`, `PORTAINER_ENDPOINT_ID`, `PORTAINER_STACK_ID`). The
   deploy job is skipped silently on every push. **The release chain stays unproven until they
   are set and one real push to `main` has completed** — `workflow_dispatch` cannot trigger a
   deploy, so a green CI run on a branch says nothing about it.
3. **Charge-at-booking has not been signed off.** The build debits at booking; client
   blueprint A.9 says lights-on. Recorded as deviation **D-1** in
   `docs/specs/client-blueprint-deltas.md`. The blueprint is the customer's own word and
   outranks internal specs on economics, so this is not the repo's decision to close.
4. **The first ESP8266 flash may need a USB-TTL adapter, and nobody has checked.** The wiring
   sheet documents DIP positions for Serial3↔ESP and USB↔Mega but not for USB↔ESP8266 with
   GPIO0 low. If there is no such position the schedule is wrong by however long it takes to
   find an adapter. Every flash after the first is OTA.
5. **The firmware signing key does not exist.** OTA images are verified against a public key
   compiled into the build; neither half has been generated. Until then no update can ship and
   the boards are USB-only.
6. **Power: two ESP nodes on one LM2596 5V rail** with relay coils, LCD backlight and scanner.
   A browning-out rail produces exactly the intermittent faults that get blamed on software —
   and now specifically: three spurious resets read to `ota::BootGuard` as a failed firmware
   and condemn a good build. The symptom will look like a bad release and will not be one.
7. **Queued device events do not survive a power cut.** They survive the WiFi going away and a
   two-day outage; the ring is in RAM because `hal::IStore` caps a value at 32 bytes. A court
   lit during an outage that ended in a power cut is never reported, so the sweep refunds it
   less a penalty the member did not earn. Visible in the ledger, reversible by an admin.
   Accepted knowingly; item 6 makes it rarer.
8. **The frontend deviation is still unwaivered.** No shadcn/ui, no Radix, no Redux Toolkit,
   against the parent mandate. Either adopt or record a rationale. The hand-rolled primitives
   now have tests, which is a mitigation and not a waiver — and those tests found two
   accessibility defects a library would have shipped correct.
9. **No architecture doc exists for the backend.** `src/iot/README.md` covers the hardware
   split thoroughly; nothing covers the API.

## Resolved since the last stamp

- ~~No device credential~~ — device auth, provisioning and discovery are built; a board
  collects its own key with the claim code shown on its LCD, and no admin JWT is baked into
  anything.
- ~~`development-plan.md`'s status snapshot is wrong~~ — replaced with a per-deliverable table.
