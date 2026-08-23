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
9. **The roster is never pushed to a box, so the offline path is unreachable in practice.**
   `lib/roster` is built and tested, but nothing populates it — and the reason is a design
   question rather than a missing endpoint. The QR token is a **60-second signed JWT**, so it
   cannot be pre-cached by construction; a box holding a stable copy of somebody's identity
   is a box that opens a court for them forever. So an offline roster needs a *stable*
   identifier — a PIN-derived token or a printed code — and that is a security trade nobody
   has taken: a token the box can compare against a typed PIN is a token a stolen box can
   brute-force over the 10,000 space for the members in its cache.
   **Until that is decided, a court box needs the network to admit anybody.** What works
   today is the online path: scan, POST, decide.
10. **A claimed box still announces itself as unclaimed.** `discovery::Packet::announceClaimed`
   exists and is called nowhere; `broadcastAnnounce` always builds the unclaimed form, so a
   provisioned board keeps broadcasting its claim nonce and commitment every five seconds and
   keeps appearing in the admin's discoverable list. **Not exploitable**: the API answers a
   second claim with `board_already_claimed`, and a provisioned box now verifies OFFER
   signatures (`ClaimedBox`), so the repoint attack is closed. What blocks the fix is that the
   device stores no tenant slug — `loadCredentials` reads the device id and key only — and
   `announceClaimed` needs one. Adding slug storage is the work.
11. **OTA is blocked in every shipped build, on purpose.** `considerUpdate` now refuses to
   install unless a public key is compiled in, and none exists (item 5). Before this it flashed
   an unsigned image fetched over plain HTTP from a URL taken out of an unauthenticated
   response body, under a comment claiming the core verified it against a compiled-in key —
   which was describing the intended design as though it were shipped. Boxes are USB-only
   until the key pair is generated, and the display says `UPDATE BLOCKED / NO SIGNING KEY`
   rather than failing quietly.
12. **Blocking HTTP in `loop()` can drop Mega frames.** Every heartbeat and walk-up makes a
   synchronous `http.POST`, and the ESP8266 UART RX ring is 256 bytes — 267 ms at 9600 baud —
   against a 5 s HTTP timeout. The relay tick is unaffected (it runs on the Mega, which is the
   point of the split), but `!SCAN` and `!EVT,AUTOOFF` can be lost mid-frame. `Serial.setRxBufferSize`
   is never called; raising it is the cheap half of the fix.
13. **No architecture doc exists for the backend.** `src/iot/README.md` covers the hardware
   split thoroughly; nothing covers the API.

## Resolved since the last stamp

- ~~No device credential~~ — device auth, provisioning and discovery are built; a board
  collects its own key with the claim code shown on its LCD, and no admin JWT is baked into
  anything.
- ~~`development-plan.md`'s status snapshot is wrong~~ — replaced with a per-deliverable table.
