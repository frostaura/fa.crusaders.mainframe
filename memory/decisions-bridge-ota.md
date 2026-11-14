---
name: crusaders-mainframe-decisions-bridge-ota
description: "Bridge 3.1.0 (2026-11-14, fix/bridge-ota): the bridge's last cable flash - signed OTA with prev.bin rollback, key ring, runtime network, portal, supervisor, flash persistence, and how it fits the heap floor."
type: decision
last_verified: 2026-11-14
---

# Decisions — bridge 3.1.0, phase B (the bridge's last cable flash)

Contract and its why: `decisions-device-v3*.md`. These are the bridge's own choices.

- **Verify through the core's own Updater hook, not a parallel hash.** `Update.installSignature`
  with a zero-length verifier makes `Update.end()` read the STAGED bytes back from flash, hash
  them and ask our check (size, SHA-256, RSA over the manifest) before eboot's copy is armed.
  *Why:* what is verified is what eboot will copy, and a refusal is a clean `_reset()`.
- **The running image is copied to `/ota/prev.bin` (SHA-256 recorded) before a byte is
  staged; no copy, no update.** *Why:* eboot overwrites the running image; this copy is the only
  way back. Rollback re-stages it the same verified way; a damaged copy is never flashed back —
  the new image (which boots) is kept and reported `failed`/`flash`.
- **Probation is counted in a flash record first thing in `setup()`**; the fourth unproven boot
  or the window rolls back; commit needs an accepted beat with the Mega heard. Exits `75`/`76`
  in `bridge_sim` play restart/crash. *Limit:* a crash before `setup()` (static init) is not
  counted — only the bench and the window catch it.
- **RSA is checked at the top of a LATER pass, in the heartbeat buffer**, once the answer it
  came in has been written to flash. *Why:* the 1.8 KB workspace costs no RAM that way.
- **One 5 KB buffer (`gBig`) holds the answer, the request (its tail), the member reply, the RSA
  workspace, the OTA chunks and the portal's scratch** — none overlap in time. **Tables are
  flash-resident** (`bridgelogic/FlashTable.h`, `memcpy_P` copies of rows with byte fields;
  pointer/word tables read in place). **The roster and the 64-key ring replace in place**, each
  deciding an all-unreadable array in a first pass (FC-1). *Why:* phase B added ~8 KB of static
  RAM to an image 240 B above the 24 KB heap floor. Result: static 57,272 → heap 24,648 B.
- **The last accepted answer is persisted WHOLE and re-adopted through the live readers.**
  *Why:* one adoption path; a restored box cannot read its own flash differently from the wire.
  Once a minute, at once when the lit set changes. Warm = RTC-memory epoch (exact ages); cold =
  as of boot, roster trusted for the trust window then forgotten, codes wait for a beat, owed
  courts lit provisionally (capped) and switched off by the bridge if the first snapshot says
  dark (cause `reconcile`).
- **Events are persisted per sealed entry and carried to the next boot under their own boot id**,
  re-uploaded from the start after another cut (the server dedups on device/boot_id/seq); faults
  shed first past 64. Delivered carried entries are not rewritten out — the file goes when all are.
- **The portal is a bounded `WiFiServer` parse, not ESP8266WebServer.** *Why:* its form parser
  has an unbounded VLA frame the stack gate refuses, and its templates cost RAM.
- **A line the Mega garbled earns a `!PING`** (3, then one per 5 s), and a reset is a moved boot
  instant (`MegaBootClock`), not "uptime went down". *Why:* soak seeds 114940677/110498118 — a
  lost `!BOOT` left a paid court dark for the Mega's 10 s `!STATE` period.
- **Exact integer kinds in `devapi` for every reader** (FC-11): `60.5`/`4.5e1` read as absent.
- **D10 pay-for is out of the image** (main.cpp no longer reaches it; `PayFor.cpp` and its tests
  remain in the tree, unlinked by `--gc-sections`).
- **Companion sources beside `main.cpp`** (`src/court_bridge/EspLifeline.*`) because it speaks
  bridgelogic's ports and `arduino_hal` is the Mega's too; `arduino_export.py` exports them.

## Proven, and what is still only provable on the chip

`test_lifeline` (21), the 20,000-sequence soak (0 violations), `ota_e2e.py` 19/19 against the
real API (discover → verify → copy → download → stage → verify → switch → probation → commit;
crash ×3 → fourth-boot rollback → `rolled_back`, never re-offered). **Bench only:** the core's
Updater/eboot on the real ESP8266, LittleFS wear, the softAP, the RTC epoch across a watchdog
reset. The checklist (§5) makes a per-box OTA round trip the condition for sealing.
