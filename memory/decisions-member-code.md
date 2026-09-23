---
name: crusaders-mainframe-decisions-member-code
description: "D1's single rotating code as built in firmware: 19 chars so the Mega stays untouched, ON server-only and OFF under a 12-byte per-day key devices hold, rosters naming players, pay-for at the box in three rows, flash owed."
type: decision
last_verified: 2026-09-23
---

# Live decisions — the single rotating member code, in firmware and contract

Oracle: `docs/specs/member-code.md`; corpus `src/contracts/device-protocol/membercode/`, generated
by `src/iot/tools/membercode_vectors.py` and checked by `make corpus-check`. Landed on branch
`fw/p7-code` (P7 firmware + contract lane); backend and PWA lanes implement §4–§10 against it.

- **Token = `1` + REF(4 Crockford) + ON(8) + OFF(6) = 19 characters.** *Why:* it fits every limit
  the Mega's firmware already enforces (scan line and `!SCAN` 24, roster/door cap 20), so the
  Mega is not reflashed and its dialect is untouched; and every legacy code is 12, so length alone
  separates the two — no scan reads both ways.
- **ON = TOTP-8 under the member secret S (HKDF of the master key), server and phone only; OFF =
  TOTP-6 under K_day = HMAC(S, "crusaders/kday/v1|" + club day), first 12 bytes.** *Why:* devices
  can check OFF offline without ever holding S, so a stolen box forges OFF for ~a day for the
  members it holds and never ON, and uploads are re-checked with ON (`code.forgery_suspected`).
  12 bytes, base64url, is what fits 72 keys into a door's 4096-byte body (3879 at the widest).
- **Devices get a step counter (`code_step` + `code_step_ms`), never a Unix time** — the 2.0.0
  removal of `server_unix` stands. Trusted as long as the roster (six hours).
- **A roster entry names the booking's players: `m` + 1–4 REFs.** Scanned strings match only
  legacy entries and a PROVED REF matches only REF lists. *Why:* a REF is printed in every code;
  if the paths crossed, `m` + somebody's REF would open their court. Pinned both ways.
- **Replay rings record only ACTIONS** (a court actually lit, a lock actually given time), per REF
  the highest step. *Why:* a member told TOO EARLY who rescans is not replaying.
- **`caps:["codes:m1"]` on every heartbeat, last**; an image that names nothing renders its old
  body byte for byte, so every existing vector still holds.
- **D10 pay-for runs down three rows, not the founder's two lines** — `CT2 BOOKED` / `PAY 50cr?` /
  `PRESS CT2 TO PAY`. *Why:* as two lines row 1 is 19 columns and the 16-column safe subset clips
  its instruction off. `SPLIT - PAY IN APP` became `SPLIT BOOKING` / `PAY IN APP` for the same
  reason. Proven at court 9999 / label 9999.5 by the screen-contract test.
- **Pay-for is online only and any non-decision is the old walk-up choice** (a 404 from a server
  without the endpoint included), so a box flashed ahead of its server behaves exactly as before.
  The confirm echoes the server's `amount_label`; a mismatch is `price_changed`, never a charge.
- **Versions: bridge 2.1.0, Mega stays 2.0.0, door 1.1.0.** The bridge unflags `[common]`'s MINOR
  by `[common]`'s own token and sets its own, so `[common]` stays byte-identical and the Mega
  sketch does not move. The Devices page showing these numbers is how a flash is confirmed.
- **Owed, and nobody but Dean can do the first:** flash the ESP8266 bridge and each door ESP32
  (spec §8.1; the Mega is not touched); the backend lane (endpoints, rosters, cut-over, forgery
  alert) and the PWA lane (enrol, WebCrypto, My Code). Nothing has run on hardware.
