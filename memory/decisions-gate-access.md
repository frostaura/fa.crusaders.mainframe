---
name: crusaders-mainframe-decisions-gate-access
description: "Who a door opens for: a booking code bounded by its own booking, capped at four hours, topped by the code's own expiry; a member is not a credential; admins pass online only; 403 can mean nothing but out of service."
type: decision
last_verified: 2026-09-19
---

# Live decisions — who a door opens for

The gate's shape is [`decisions-gate.md`](decisions-gate.md); how a board reports on itself is
[`decisions-device-alerts.md`](decisions-device-alerts.md). Oracle: `docs/specs/door-gate.md`
§5, §7 and §10a.

- **A booking code opens a door only inside its own booking's window, under every policy** —
  `[StartsAt − H, the code's own expiry]`, `H = gate_early_entry_minutes` under `booking_window`
  and `max(that, min(roster_window + activation_cue, 240))` under `active_member`. Outside it:
  `too_early` before, `not_recognised` after. *Why:* the code is a stable token for the whole slot,
  which is what a court box deciding offline needs and what made it a **building key** at a door —
  the QR a phone showed at 17:00 for a 19:00 court opened every door at 03:00. `MemberIdent` codes
  name no booking and are unaffected.
- **Capped at four hours, all three inputs clamped ON READ.** `MaxEarlyEntryMinutes` bounded
  `gate_early_entry_minutes` alone; the other term is two settings the PUT bounds at 1440 each,
  cross-checked only against each other — so a club could give every code in the building a
  48-hour door window through the console while the spec and the constant both said four, and a
  hand-edited column was unbounded since `TenantSettingsAccessor` clamps nothing. The bounds live
  once on `TenantSettingsView`, and the gate ROSTER reads the entry window through the same
  function: an unclamped cache would admit offline what the API refuses online. The phone is not
  narrowed to match — past the ceiling the door says `too_early`, which is actionable.
- **The upper edge is the CODE's liveness, not the booking's `EndsAt`.** `ResolveAsync` already
  refuses a dead code, so testing `EndsAt` too was a second, lower bound, wrong both ways: the
  sweep truncates `EndsAt` five minutes into a slot, and a member whose court merely ran to its end
  was refused for the grace window while the product still held a live code for them. Intended
  consequence: the door is a grace window WIDER at the top than the phone, the offline roster that
  much narrower — the single place offline is stricter. Nothing extends a booking, so `ExpiresAt`
  is never behind the row; an extend feature must move the mint path with it.
- **A member is not a credential.** A booking code outside its own window still opens iff the same
  member holds another qualifying booking whose door window contains now, and `NoShow` qualifies:
  a member six minutes late was refused OUTSIDE the building while the only way to reverse a wrong
  no-show is scanning at the court box INSIDE it. `Cancelled`, `Completed`, `AdminBlock` admit
  nobody. One query, two horizons — the first draft had it twice and a mutant proved the second
  copy changed no outcome.
- **Club admins always pass the `booking_window` check; there is no operator role.** Keyed on
  `IsAdmin`, because the ABSENCE of a membership row is a state no production path creates.
  **Three** limits: a suspended admin is still `member_not_active`; an admin's booking code is
  still bounded by its own window; and — the one no test can pin — **the carve-out does not exist
  offline**, because a roster holds bookings and staff on shift hold none.
- **The code's user IS the booking's user, structurally.** `StageForBookingAsync` refuses a booking
  with no user rather than falling back to `BookedByUserId`, so the roster's barred filter (keyed
  on the booking's user) and the online check (keyed on the code's) cannot disagree about whom a
  suspension binds. The unreachable `b.Id == resolved.BookingId` disjunct went with it.
- **`403` is authoritative, and on this surface it can mean NOTHING ELSE.** Deny the scan with no
  roster fallback; commit an empty roster on a 403 heartbeat. Everything else falls back, being
  evidence about the link rather than the club's decision. Only the forward direction was pinned,
  and the converse is what the firmware depends on. Enumerated three ways — routes and metadata,
  the SOURCE of everything that serves or wraps the group, and every refusal a board can provoke.
  One exception, a 400: an unknown `kind` is refused before the MAC is resolved. **Residual:** a
  cut-off board never hears the 403 and admits rostered bookings for six hours.
