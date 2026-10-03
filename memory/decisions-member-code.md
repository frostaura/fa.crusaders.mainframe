---
name: crusaders-mainframe-decisions-member-code
description: "D1's single rotating code as built in firmware: 19 chars so the Mega stays untouched, ON server-only and OFF under a 12-byte per-day key devices hold, rosters naming players, pay-for at the box in three rows, flash owed."
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
- **D10 pay-for runs down three rows** — `CT2 BOOKED` / `PAY 45 MIN?` / `PRESS CT2 TO PAY`. *Why:*
  as two lines the 16-column safe subset clips the instruction (so `SPLIT BOOKING` / `PAY IN APP`
  too). P13 (2.2.0): minutes, `amount_label` 1–4 digits (> 9999 is `amount_unshowable`).
- **Pay-for is online only; any non-decision (a 404 included) is the old walk-up choice.** The
  confirm echoes the server's `amount_label`; a mismatch is `price_changed`, never a charge.
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
- **Versions: bridge 2.2.4, Mega 2.0.0 (never reflashed), door 1.1.0.** The bridge unflags
  `[common]`'s MINOR/PATCH by its own tokens; the Devices page showing these confirms a flash.
- **Owed, and nobody but Dean can do the first:** flash the ESP8266 bridge and each door ESP32
  (spec §8.1; the Mega is not touched); the PWA lane (enrol, WebCrypto, My Code). The backend
  half landed on `be/p7-code` — see `decisions-member-code-backend.md`. Nothing has run on hardware.
