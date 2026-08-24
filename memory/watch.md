---
name: crusaders-mainframe-watch
description: "Ordered by risk: the 30 confirmed defects of the 2026-08-24 E2E review (booked-member path does not exist — 7 criticals, C2+C6 must ship together); the relay/contactor safety question; 6 Actions secrets unset; committee sign-off on charge-at-booking; OTA unsignable (private key unlocatable, no release job); unwaivered frontend deviation"
type: watch
last_verified: 2026-08-24
---

# Watch list

**Ordered by risk.** The safety and checklist items are expanded, with the
consequence of skipping each, in [`docs/go-live-checklist.md`](../docs/go-live-checklist.md).

0. **The 2026-08-24 adversarial E2E review confirmed 30 defects — the booked-member path
   (book → scan → lights) does not exist end to end.** Full file-and-line evidence and
   wiring-preserving fix directions:
   [`docs/reviews/e2e-adversarial-review-2026-08-24.md`](../docs/reviews/e2e-adversarial-review-2026-08-24.md).
   Two couplings are load-bearing: **C6 (activation events never become attendance) must land
   in the same release as C2 (roster never populated)** or every attended booking is swept as a
   no-show, refunded and penalised; and the walk-up court mismatch (C5) plus non-idempotent
   walk-up purchase (H3) both move real money today. The wiring is exonerated — zero electrical
   findings; do not touch it. The review also lists 7 physical-verification items (report §4)
   that belong on the go-live checklist.
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
4. ⟨corrected 2026-08-24⟩ **The first-ESP-flash DIP position IS documented — the earlier claim
   here was wrong.** The canonical wiring sheet's "Uploads & Dips" carries a dedicated ESP8266
   upload row: `1 OFF, 2 OFF, 3 OFF, 4 OFF, 5 ON, 6 ON, 7 ON, 8 OFF` (differs from USB-monitor
   only in DIP 7, the flash-mode line). No USB-TTL adapter is needed. `src/iot/README.md`,
   go-live checklist item 5 and `memory/questions.md` still repeat the false "undocumented"
   claim and prescribe clipping onto the pads of the fixed build — those docs are the defect
   (review finding A2-1); fix them before anyone touches the hardware.
5. ⟨corrected 2026-08-24⟩ **OTA is unsignable, not "working against a default key".** Only the
   public half is committed; the private half is unlocatable anywhere (repo, CI secrets — and
   `generate_ota_keys.sh` refuses to regenerate the same pair), no CI job sets
   `OTA_PRIVATE_KEY`, signs firmware or hosts a `.bin` for `Ota:Stable:Url` (findings
   A2-2/A2-3). Every board flashed with the current `OtaPublicKey.h` will reject every image
   nobody can sign — the checklist's "If skipped: OTA works" is false. Key generation +
   a real signing/publishing release job are hard prerequisites of the first flash.
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
10. **No architecture doc exists for the backend.** `src/iot/README.md` covers the hardware
   split thoroughly; nothing covers the API.

## Resolved since the last stamp

- ~~No device credential~~ — device auth, provisioning and discovery are built; a board
  collects its own key with the claim code shown on its LCD, and no admin JWT is baked into
  anything.
- ~~`development-plan.md`'s status snapshot is wrong~~ — replaced with a per-deliverable table.
- ~~A claimed box announces itself unclaimed~~ — the device now stores its tenant slug at
  provisioning and `broadcastAnnounce` sends a signed `announceClaimed` once provisioned, so a
  connected board drops out of the admin's discoverable list. `Packet::shouldAnnounceClaimed`.
- ~~OTA is blocked in every build~~ — the signing pipeline is built and OTA works. A committed
  public key enables enforcement, `tools/sign_firmware.py` signs images, and the build produces
  `firmware.signed.bin` when `$OTA_PRIVATE_KEY` is set. The residual is item 5: the committed
  key is a repo default the club must rotate before go-live.
- ~~Blocking HTTP in `loop()` can drop Mega frames~~ — the ESP8266 receive ring is raised to
  4 KB (~4.3 s at 9600 baud), blocking HTTP is bounded to 4 s under that, and the loop drains
  the Mega link before the blocking calls. A mitigation, not a cure — non-blocking HTTP remains
  the eventual fix — but a byte lost to an overrun costs one frame, which is now a pinned test.
