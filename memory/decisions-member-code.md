---
name: crusaders-mainframe-decisions-member-code
description: "D1's single rotating code as built in firmware: 19 chars so the Mega stays untouched, ON server-only and OFF under a 12-byte per-day key devices hold, rosters naming players, pay-for at the box in three rows, flash owed."
type: decision
last_verified: 2026-10-03
---

# Live decisions — the single rotating member code, in firmware and contract

Oracle: `docs/specs/member-code.md`; corpus `src/contracts/device-protocol/membercode/` (from
`src/iot/tools/membercode_vectors.py`, checked by `make corpus-check`).

- **Token = `1` + REF(4 Crockford) + ON(8) + OFF(6) = 19 characters.** *Why:* it fits every limit
  the Mega's firmware already enforces (scan line and `!SCAN` 24, roster/door cap 20), so the
  Mega is not reflashed and its dialect is untouched; and every legacy code is 12, so length alone
  separates the two — no scan reads both ways.
- **ON = TOTP-8 under the member secret S (HKDF of the master key), server and phone only; OFF =
  TOTP-6 under K_day = HMAC(S, "crusaders/kday/v1|" + club day), first 12 bytes.** *Why:* devices
  can check OFF offline without ever holding S, so a stolen box forges OFF for ~a day for the
  members it holds and never ON, and uploads are re-checked with ON (`code.forgery_suspected`).
  12 bytes, base64url, is what fits 72 keys into a door's 4096-byte body (3879 at the widest).
- **Devices get a step counter (`code_step` + `code_step_ms`), never a Unix time**; trusted six hours.
- **A roster entry names the booking's players: `m` + 1–4 REFs.** Scanned strings match only
  legacy entries and a PROVED REF matches only REF lists. *Why:* a REF is printed in every code;
  if the paths crossed, `m` + somebody's REF would open their court. Pinned both ways.
- **Replay rings record only ACTIONS** (a court actually lit, a lock actually given time), per REF
  the highest step, **online ones included**. *Why:* a member told TOO EARLY who rescans is not
  replaying; and without the online record a photo of a code the server just accepted opened the
  same door again the moment the link dropped (found by an independent review, 2026-09-23).
- **Offline OFF guessing is bounded by a guard, not denied** — five wrong codes a minute lock
  offline checks, doubling to 30 min (`GuessGuard.h`). *Why:* a REF is public and 6 digits at 3
  steps is 3e-6 a guess; unguarded, rotating QR codes at scanner speed opened a door in hours.
  Only `wrong_code` counts, so a member without a key cannot lock the door for everybody.
- **Server use table is per (REF, step, class ∈ door/court/money)**; a used code arms no buttons.
  *Why:* front door then court inside one step is two uses, not a replay or a forgery.
- **A device that loses its key entitlement is sent EMPTY `code_days`/`code_keys`, never an
  omission** — an absent key means "no member codes here" and keeps the old ring.
- **`caps:["codes:m1"]` on every heartbeat, last**; an image naming nothing renders its old body.
- **D10 pay-for runs down three rows, not the founder's two lines** — `CT2 BOOKED` / `PAY 45 MIN?` /
  `PRESS CT2 TO PAY`. *Why:* as two lines row 1 is 19 columns and the 16-column safe subset clips
  its instruction off. `SPLIT - PAY IN APP` became `SPLIT BOOKING` / `PAY IN APP` for the same
  reason. P13 (bridge 2.2.0): `PAY n MIN?` / `n MIN PAID` / `TOO FEW MINUTES` / `BUY & RETRY`;
  `amount_label` 1–4 whole digits (> 9999 is `amount_unshowable` before money moves); 2.1.0 prints "cr".
- **Pay-for is online only and any non-decision is the old walk-up choice** (a 404 from a server
  without the endpoint included), so a box flashed ahead of its server behaves exactly as before.
  The confirm echoes the server's `amount_label`; a mismatch is `price_changed`, never a charge.
- **A code the device already acted on is refused LOCALLY before any online call**
  (`memcode::knownReplay`, both ESP boards; the Mega is untouched). *Why:* offline open, link
  back, photo of the code scanned before the open was uploaded — the server had not heard of the
  first use and acted again (refute round 2, 2026-09-28). The server now also flags that order.
  **Except on the member's own lit court** (bridge 2.2.1, D6-3): a replay whose proved REF holds a
  lit court here is `COURT B IS ON` with OFF bound and the scan SPENT. *Why:* `CODE USED` disarmed
  the owner's OFF; spending keeps a photo from buying a walk-up or pay-for. 2.2.2 (D7-1): or a court
  this box lit ONLINE for that REF (`OnlineGrants`) — a walk-up/pay-for buyer is on no roster yet.
- **Versions: bridge 2.2.2, Mega stays 2.0.0, door 1.1.0.** The bridge unflags `[common]`'s MINOR
  and PATCH by `[common]`'s own tokens and sets its own; `[common]` stays byte-identical and the
  Mega sketch does not move. The Devices page showing these numbers is how a flash is confirmed.
- **Owed, and nobody but Dean can do the first:** flash the ESP8266 bridge and each door ESP32
  (spec §8.1; the Mega is not touched); the PWA lane (enrol, WebCrypto, My Code). The backend
  half landed on `be/p7-code` — see `decisions-member-code-backend.md`. Nothing has run on hardware.
