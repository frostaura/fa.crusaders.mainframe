---
name: crusaders-mainframe-decisions-gate-access
description: "Who a door opens for: a booking code bounded by its own booking, capped at four hours and clamped at every reader; NoShow and Completed both count; admins pass online only; 403 can mean nothing but out of service."
type: decision
last_verified: 2026-09-19
---

# Live decisions — who a door opens for

Shape: [`decisions-gate.md`](decisions-gate.md). Self-reporting:
[`decisions-device-alerts.md`](decisions-device-alerts.md). Oracle: `door-gate.md` §5, §7, §10a.

- **A booking code opens a door only inside its own booking's window, under every policy** —
  `[StartsAt − H, the code's own expiry]`, `H = gate_early_entry_minutes` under `booking_window`
  and `max(that, min(roster_window + activation_cue, 240))` under `active_member`; `too_early`
  before, `not_recognised` after. *Why:* the code is a stable token for the whole slot — what a
  court box deciding offline needs, and what made it a **building key** at a door: the QR a phone
  showed at 17:00 for a 19:00 court opened every door at 03:00. `MemberIdent` codes name no
  booking and are unaffected.
- **Capped at four hours, and EVERY reader clamps on read.** `MaxEarlyEntryMinutes` bounded
  `gate_early_entry_minutes` alone, while the other term is two settings the PUT bounds at 1440
  each — so a club could buy a 48-hour door window through the console while the spec said four,
  and `TenantSettingsAccessor` clamps nothing, so a hand-edited column reached every reader raw.
  G2 clamped the online decision and left three: both roster builders' windows and the phone's
  horizon, so `roster_window_minutes: -600` emptied every board's cache on a clean 200 with no
  error and no log. All now read through `BookingCodeWindow`; the phone is not narrowed.
- **The upper edge is the CODE's liveness, not the booking's `EndsAt`.** `ResolveAsync` already
  refuses a dead code, so testing `EndsAt` too was a second, lower bound, wrong both ways. The
  door is therefore a grace window WIDER at the top than the phone and the offline roster that
  much narrower — the single place offline is stricter. The STATUS test is a second upper edge
  reached first, which is how `Completed` hid. Nothing extends a booking, so `ExpiresAt` is never
  behind the row; an extend feature must move the mint path with it.
- **A member is not a credential, and BOTH workers' statuses qualify.** A booking code outside its
  own window still opens iff the member holds a qualifying booking whose door window contains now.
  `Booked`, `NoShow` **and `Completed`** count; only `Cancelled` and `AdminBlock` — what the
  CLUB decided — admit nobody. `NoShow` because a member six minutes late was refused OUTSIDE the
  building while the only cure for a wrong no-show is scanning at the box INSIDE it. `Completed`
  because `LightsCueWorker` promotes a CHECKED-IN booking within fifteen seconds of its end, so
  the relief reached the member who did **not** come and refused the one who had just played — and
  it survived two rounds on its FIXTURE: three theories set `Completed` by hand on rows with
  `CheckedInAt == null`, a state the product cannot make. The pin drives the real worker; the
  relief's horizon is the DOOR's, not the entry window.
- **Club admins always pass the `booking_window` check; there is no operator role.** Keyed on
  `IsAdmin`: the ABSENCE of a membership row is a state no production path creates. **Three**
  limits — a suspended admin is still `member_not_active`, their booking code is still bounded by
  its own window, and (the one no test can pin) **the carve-out does not exist offline**, because
  a roster holds bookings and staff on shift hold none.
- **The code's user IS the booking's user, structurally.** `StageForBookingAsync` refuses a booking
  with no user rather than falling back to `BookedByUserId`, so the roster's barred filter (on the
  booking's user) and the online check (on the code's) cannot disagree about whom a suspension
  binds. The unreachable `b.Id == resolved.BookingId` disjunct went with it, and the `?? throw` is
  now pinned directly: any fallback restores the divergence silently.
- **`403` is authoritative, and on this surface it can mean NOTHING ELSE.** Deny the scan with no
  roster fallback; commit an empty roster on a 403 heartbeat. Everything else falls back, being
  evidence about the link rather than the club's decision. The converse is what the firmware
  depends on and is enumerated three ways — routes and metadata, the SOURCE of everything that
  serves or wraps the group, and every refusal a board can provoke. Two exceptions, neither a 403:
  an unknown `kind` is a 400, and the unacknowledged-registration cap a **409**. That pin is
  application-level; the gateway half is in [`decisions-gate-threat.md`](decisions-gate-threat.md).
  **Residual:** a cut-off board never hears the 403 and admits rostered bookings for six hours.
