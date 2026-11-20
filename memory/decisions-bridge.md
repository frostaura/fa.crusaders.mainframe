---
name: crusaders-mainframe-decisions-bridge
description: "The ESP8266 bridge 3.1.0: phase A's paced Mega link and snapshot reconcile, phase B's key ring, server-pushed network, supervisor and flash persistence, how it fits the heap floor, and why OTA and the hotspot left before it shipped."
type: decision
last_verified: 2026-11-20
---

# Decisions — the court box's bridge (ESP8266), 3.0.0 phase A and 3.1.0 phase B

Contract and its why: `decisions-device-v3*.md`; versions: [`decisions-court-box.md`](decisions-court-box.md); scan
flows: [`decisions-bridge-scan-flows.md`](decisions-bridge-scan-flows.md). Phase A was built on `fix/court-box`, phase B
on `fix/bridge-ota`; the OTA half was removed on `fix/no-ota-fw` (`f4a9b20b`), version unchanged.

- **Phase A (3.0.0, never to be flashed):** `MegaTx` (paced, tagged, acked, one screen in flight), the snapshot reconcile
  on every beat / boot / contradiction, the v3 heartbeat, no identity overlays, release `cause`, one 512-byte reply buffer.
- **Caps at 3.1.0:** `codes:m1 hb:3 lcd:2 key:1 net:1` (`court_bridge/main.cpp:2460`; rendered in bit order, so the wire
  order is `codes:m1, hb:3, key:1, net:1, lcd:2`).
- **No OTA in the image** (founder, 2026-11-14 — full decision in `decisions-device-v3.md`). Gone: the Updater/eboot
  staging, the firmware download, the `/ota/prev.bin` copy and rollback, boot probation, `OTA_PUBLIC_KEY_N`,
  `bridge_sim` (it existed only for `ota_e2e.py`). *Superseded design, for whoever restores it from `99e9c5ee`:*
  verification ran through the core's own `Update.installSignature` hook so what was verified was what eboot copied, and
  the running image was copied to LittleFS first because eboot overwrites the only way back.
- **No setup hotspot** (removed 2026-11-14, `899e4388`): the softAP, its form parser, the A + D chord and `local`
  adoption are gone; the network is compiled in and re-pointed by cable or the server's `net`. *Superseded design:* a
  bounded `WiFiServer` parse, because ESP8266WebServer's form parser has an unbounded VLA frame the stack gate refuses.
- **One 5 KB buffer (`gBig`, `kHeartbeatResponseCap` 5120) holds the answer, the request (its tail) and the member
  reply** — none overlap in time. **Tables are flash-resident** (`bridgelogic/FlashTable.h`, `memcpy_P` copies of rows
  with byte fields; pointer/word tables read in place). **The roster and the 64-key ring replace in place**, each
  deciding an all-unreadable array in a first pass (FC-1). *Why:* phase B added ~8 KB of static RAM to an image 240 B
  above the 24 KB heap floor. Headroom is not a licence — the floor binds (heap at the tip: [`state.md`](state.md)). The
  comment on `gBig` (`main.cpp:578-598`) still quotes the 2048-byte / 1023-byte 2.x figures; the request cap is 1536.
- **The last accepted answer is persisted WHOLE and re-adopted through the live readers.** *Why:* one adoption path; a
  restored box cannot read its own flash differently from the wire. Written once a minute, and at once when the lit set
  changes. Warm = RTC-memory epoch (exact ages); cold = as of boot, roster trusted for the trust window then forgotten,
  codes wait for a beat, owed courts lit provisionally (capped) and switched off by the bridge if the first snapshot
  says dark (cause `reconcile`).
- **Events are persisted per sealed entry and carried to the next boot under their own boot id**, re-uploaded from the
  start after another cut (the server dedups on device/boot_id/seq); faults shed first past 64. Delivered carried entries
  are not rewritten out — the file goes when all are.
- **A line the Mega garbled earns a `!PING`** (3, then one per 5 s), and a reset is a moved boot instant
  (`MegaBootClock`), not "uptime went down". *Why:* soak seeds 114940677 / 110498118 — a lost `!BOOT` left a paid court
  dark for the Mega's 10 s `!STATE` period.
- **Exact integer kinds in `devapi` for every reader** (FC-11): `60.5` / `4.5e1` read as absent.
- **D10 pay-for is out of the image**: `main.cpp` no longer reaches it; `PayFor.cpp` and its tests remain in the tree,
  unlinked by `--gc-sections`, because deleting it shifts `ScreenScript` ids for no image gain (dead source owed).
- **Companion sources beside `main.cpp`** (`src/court_bridge/EspLifeline.*`) because it speaks bridgelogic's ports and
  `arduino_hal` is the Mega's too; `arduino_export.py` exports them.
- **`loop()` must fit its 4 KB stack**: the ironclad integration found 4,144 B deepest through two 960-byte screen
  encode buffers, sized from the frames to 3,136 B; 3.1.0 moved the lifeline out of `loop()`'s frame (928 → 208 B) and
  the deepest path is 2,720 B against a 2,768 B ratchet and a 3,000 B goal (`stack_budget.json`). *Why it matters:* it
  would have crashed on the wall on the first chained screen, and no host test can see a stack.
- **Provable only on the chip:** LittleFS wear and the RTC epoch across a watchdog reset.
