---
name: crusaders-mainframe-decisions-member-code
description: "D1's single rotating code as built in firmware: 19 chars to fit the Mega's limits, ON server-only and OFF under a 12-byte per-day key devices hold, rosters naming players; pay-for left the box at bridge 3.0.0."
type: decision
last_verified: 2026-10-03
---

# Live decisions — the single rotating member code, in firmware and contract

Oracle: `docs/specs/member-code.md`; corpus `src/contracts/device-protocol/membercode/` (generated).

- **Token = `1` + REF(4 Crockford) + ON(8) + OFF(6) = 19 characters.** *Why:* it fits every limit
  the Mega already enforces (`!SCAN` 24, roster cap 20), so the Mega is not reflashed; every
  legacy code is 12, so length alone separates the two.
- **ON = TOTP-8 under the member secret S (HKDF of the master key), server and phone only; OFF =
  TOTP-6 under K_day = HMAC(S, "crusaders/kday/v1|" + club day), first 12 bytes.** *Why:* devices
  can check OFF offline without ever holding S, so a stolen box forges OFF for ~a day for the
  members it holds and never ON, and uploads are re-checked with ON (`code.forgery_suspected`).
  12 bytes, base64url, is what fits 72 keys into a door's 4096-byte body (3879 at the widest).
- **Devices get a step counter, never a Unix time**; `caps:["codes:m1"]` last on every heartbeat.
- **A roster entry names the booking's players: `m` + 1–4 REFs.** Scanned strings match only
  legacy entries and a PROVED REF matches only REF lists. *Why:* a REF is printed in every code;
  if the paths crossed, `m` + somebody's REF would open their court. Pinned both ways.
- **Replay rings record only ACTIONS** (a court actually lit, a lock actually given time), per REF
  the highest step, **online ones included**. *Why:* a member told TOO EARLY who rescans is not
  replaying; and without the online record a photo of a code the server just accepted opened the
  same door again the moment the link dropped (found by an independent review, 2026-09-23).
- **Offline OFF guessing is bounded by a guard** — five wrong codes a minute lock offline checks,
  doubling to 30 min (`GuessGuard.h`). *Why:* a REF is public; unguarded, scanner-speed guessing
  opened a door in hours. Only `wrong_code` counts, so a keyless member cannot lock the door.
- **Server use table is per (REF, step, class ∈ door/court/money)**; a used code arms no buttons.
  *Why:* door then court in one step is two uses. **But court and money exclude each other** (R8
  D8-1): a court use refuses money and turns no_booking/wrong_court into `code_used`; a money use
  refuses a court. *Why:* per class, a photo of a code that lit a court bought on the victim, and
  one that bought lit their booking at a second box.
- **A device that loses its key entitlement is sent EMPTY `code_days`/`code_keys`, never an
  omission** — an absent key means "no member codes here" and keeps the old ring.
- **D10 pay-for is out of the court-box image from bridge 3.0.0** (founder, 2026-11-13). *Why:* the
  panel stopped reaching it at 2.3.0, and dead code in a last-flash image is debt. The server keeps
  `/pay-for` (three-row glass, online only, `amount_label` echo — spec §9), held to
  `membercode/payfor.json`, read by the server only: it can return by bridge OTA, no Mega change.
- **A code the device already acted on is refused LOCALLY before any online call**
  (`memcode::knownReplay`, both ESP boards). *Why:* offline open, link back, photo scanned before
  the open was uploaded — the server had not heard of the first use (refute round 2, 2026-09-28).
  **Except on the member's own lit court** (bridge 2.2.1, D6-3): a replay whose proved REF holds a
  lit court here is `COURT B IS ON` with OFF bound and the scan SPENT. *Why:* `CODE USED` disarmed
  the owner's OFF; spending keeps a photo from buying a walk-up or pay-for. 2.2.2 (D7-1): or a court
  this box lit ONLINE for that REF (`OnlineGrants`) — a walk-up/pay-for buyer is on no roster yet.
  2.2.3 (R8): only no_booking, wrong_court, too_early, insufficient_balance, not_chargeable and
  ended arm; `code_used`, not_recognised and an unknown reason arm nothing (fail closed) and the
  scan is FORGOTTEN. Activation waits on `ONE MOMENT / Checking code` (D8-2). **A walk-up or
  pay-for forgets the scan ONLY for `code_used`/`not_recognised`** (2.2.4, D9-1, in bridgelogic's
  `WalkUpResult::forgetsScan`) — never on `recognised`, false for every refusal made before the
  token resolves (TOO LONG lost the scan); `code_used` reads `CODE USED` at pay-for too (D9-2).
- **Versions** are the device contract's, not this topic's: the v3 last flash (Mega 3.0.0, bridge
  3.0.0, door 2.0.0) is [`decisions-device-v3.md`](decisions-device-v3.md); the flash order and
  what is owed are in [`state.md`](state.md). The bridge unflags `[common]`'s MINOR/PATCH by its
  own tokens. Server half: `decisions-member-code-backend.md`; keys in every phase, the cut-over's
  blockers and the v1 extend fix (2026-11-13): `decisions-member-code-cutover.md`.
