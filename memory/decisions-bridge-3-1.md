---
name: crusaders-mainframe-decisions-bridge-3-1
description: "Bridge 3.1.0 (2026-11-14): key ring, runtime network, portal, supervisor and flash persistence, how it fits the heap floor (26,536 B, 1,960 B over), and why its signed OTA was removed before it ever shipped."
type: decision
last_verified: 2026-11-14
---

# Decisions — bridge 3.1.0, phase B

Contract and its why: `decisions-device-v3*.md`. These are the bridge's own choices. Built on
`fix/bridge-ota`; the OTA half was removed on `fix/no-ota-fw` (`f4a9b20b`), version unchanged.

- **No OTA in the image** (founder, 2026-11-14: OTA is complexity the club does not need yet; full
  decision in `decisions-device-v3.md`). Gone: the Updater/eboot staging, the firmware download,
  the `/ota/prev.bin` copy and rollback, boot probation, `OTA_PUBLIC_KEY_N`, `bridge_sim` (it
  existed only for `ota_e2e.py`). Caps are `codes:m1 hb:3 lcd:2 key:1 net:1`. *Superseded design,
  kept for whoever restores it from `99e9c5ee`:* verification ran through the core's own
  `Update.installSignature` hook so what was verified was what eboot copied, and the running image
  was copied to LittleFS first because eboot overwrites the only way back.
- **One 5 KB buffer (`gBig`) holds the answer, the request (its tail), the member reply and the
  portal's scratch** — none overlap in time. **Tables are flash-resident**
  (`bridgelogic/FlashTable.h`, `memcpy_P` copies of rows with byte fields; pointer/word tables read
  in place). **The roster and the 64-key ring replace in place**, each deciding an all-unreadable
  array in a first pass (FC-1). *Why:* phase B added ~8 KB of static RAM to an image 240 B above
  the 24 KB heap floor. After the OTA removal static RAM is 55,384 B and the heap **26,536 B,
  1,960 B above the 24,576 B floor** (it was 56 B over). Headroom, not a licence: the floor binds.
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

## Provable only on the chip

LittleFS wear, the softAP portal, the RTC epoch across a watchdog reset. The checklist (§5)
makes the per-box portal check the condition for sealing. Host-test results after the removal
are the state topic's gate slot, not this topic's.
