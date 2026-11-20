---
name: technologies-crusaders-squash-control-system-decisions-booking-races-cancels
description: "Cancels that find the booking not open: booking_not_open and not_cancellable at the desk and for a member's own booking, no self-cancel once checked in, and the clock each booking path reads."
type: decision
last_verified: 2026-11-20
---

# Live decisions — cancels that find the booking not open, and who may cancel

Retries, re-decided races and the 503 net: [`decisions-booking-races.md`](decisions-booking-races.md).

- **Desk:** already cancelled → `409 booking_not_open`; played, no-show or blocked →
  `409 not_cancellable {status: completed|no_show|blocked}`; bulk: NotOpen = already cancelled, NotCancellable = failed row.
- **A member's own booking gets the same two 409s** (R18, replacing R17's 404), a double-tap's losing twin included
  (`BookingService.cs:1472,1702-1707`; `BookingEndpoints.cs:473-474`); a stranger still gets `404 booking_not_found`
  (`:1465`) — a 409 would confirm the id is real.
- **No member self-cancel once checked in** (D15-5): `409 already_checked_in`. *Why:* the refund is 0 after attendance
  and the slot went back on sale, so the club took twice. **The admin route is the club** (J15-2): neither this nor
  `already_started` applies, even on an admin's own booking; a lit started session cancels as `cancelled_no_refund`.
- **Clocks:** member create and cancel read the wall clock (`BookingService.cs:245,319,1476`); every device path reads
  the injected `TimeProvider` ([`decisions-device-bodies-clock.md`](decisions-device-bodies-clock.md)).
