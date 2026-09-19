---
name: crusaders-mainframe-decisions-gate-access
description: "Who a door opens for: a booking code is bounded by its own booking's window, club admins always pass, an unnamed board gets no roster, 403 is the club's word, and codes are bearer tokens on a cleartext LAN."
type: decision
last_verified: 2026-09-19
---

# Live decisions — who a door opens for

The gate's shape is [`decisions-gate.md`](decisions-gate.md); this is the credential half.
Oracle: `docs/specs/door-gate.md` §5, §7 and §10a.

- **A booking code opens a door only inside its own booking's window, under every policy** —
  `[StartsAt − H, EndsAt]`, with `H = gate_early_entry_minutes` under `booking_window` and
  `max(that, roster_window_minutes + activation_cue_window_minutes)` under `active_member`, and
  the booking must still be `Booked`. Outside it: `too_early` before, `not_recognised` after.
  *Why at all:* the code is a stable token for the whole slot, which is exactly what a court box
  deciding offline needs and what made it a **building key** at a door — the QR a member's phone
  showed at 17:00 for a 19:00 court opened every door in the club at 03:00. *Why the late answer
  is the same as a dead code's:* the row outlives the slot by the grace window, so a door that
  told "spent" from "unknown" apart would be an oracle for which codes are real. `MemberIdent`
  codes are unaffected — they name no booking.
- **The upper horizon is the one the member's own phone shows the code in**, and the arithmetic
  is shared with `QrEndpoints` through `BookingCodeWindow` so the screen and the door cannot
  drift. Narrower would refuse a code the product just put on somebody's screen; wider is the
  standing key again. The `max` is what keeps online never narrower than the cached roster — a
  club must not find its doors work better during an outage.
- **Club admins always pass the `booking_window` check, and there is no operator role.** *Why the
  key moved to `IsAdmin`:* it used to be the ABSENCE of a membership row, a state no production
  path creates, so the carve-out fired for nobody and a club switching policy locked its own staff
  out — and the test that said otherwise passed only because it deleted the row first. The
  carve-out is on the booking check alone; a suspended admin is still `member_not_active`.
- **A board gets no roster until an admin has named the door** (`gate_key == null` ⇒
  `roster: []`). *Why:* auto-registration is the whole provisioning story, so anything holding the
  club key can invent a MAC, register a "gate", and be answered with the club's live access codes
  for every booking in the roster window. Naming the door is the admin's acknowledgement, and it
  is the cheapest gate available on the only call that hands out credentials. Online scans work
  from the first heartbeat, so an install stays plug-and-play; what waits is the fallback.
- **`403` is authoritative and nothing else is.** It means the club took the board out of service:
  deny the scan with no roster fallback, and commit an empty roster on a 403 heartbeat.
  401/404/408/429/5xx/0/malformed-200 all fall back, because they are evidence about the link
  rather than about the club's decision. **Residual, and it is real:** a board that cannot reach
  the server never hears the 403 and keeps admitting rostered bookings until the roster goes stale
  at six hours. Out of service is not a lock.
- **A silent door does not send the court box's outage mail.** *Why it is a real defect:* that
  mail tells an admin about courts, refunds and waived no-show penalties, every clause of which is
  false about a gate — so the admin goes looking for a box that is working fine while the door
  stays shut. The door's own alert states the degraded mode and its six-hour deadline instead. A
  gate still contributes nothing to `DeviceOutageIndex` court darkness, pinned at the worker level
  as well as through the empty court list.
- **The wire is cleartext HTTP on the club LAN and codes are bearer tokens.** The court box's
  posture, written down in the spec rather than left to be assumed otherwise at a door. After the
  window rule a captured roster code buys one booking's window at every door rather than a
  standing key; the device API key is worth more than any code, and rotating it is the remedy.
  Nothing identifies the person presenting a code, so `gate.opened` names *whose code it was*,
  which is not a claim about who walked through.
