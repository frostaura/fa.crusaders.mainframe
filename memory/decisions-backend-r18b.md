---
name: crusaders-mainframe-decisions-backend-r18b
description: "Backend round 18 (lane BE18b): every audit action has a Night word or a declared exclusion, check-in subject is the organiser, lights rows print at the scan, pay-for attendance."
type: decision
last_verified: 2026-10-06
---

# Live decisions: bookings, device and the Night, review round 18 (lane BE18b)

- **No audit action reads "no word for" (E18-3).** `R18TraceGuardTests` scans the WHOLE API (every
  `const string …Action` of audit shape, every literal on an `Action = …` line); each must reach a word
  or `TraceKinds.NotAPersonsNight`. *Why:* the old guard read four named files and `court.lights_restored`
  is written from a fifth. New words: `lights.restored` ("Court N lights came back on after a power cut",
  organiser's + accepted partners'/payer's Nights via `PartnersViewActions`), `account.pin_set`,
  `pin_set_for_them`, `pin_cleared`, `fingerprint_enrolled`, `admin_inherited`. Club console acts
  (doors shut/reopen/export, monitoring resolve/export, member-code phase, retention) are declared exclusions.
- **Check-in rows: subject = the booking's organiser (E18-4)** — `court.activated` stores it so; a seat's
  `court.checked_in` is mapped from its `organiser_user_id` (`AdminMemberTraceAssembly.SubjectOf`). Actor
  is always the scanner.
- **Lights rows print at the scan (E18-7):** `CourtLightStateService.Audit` returns the row and callers set
  `ScanAt` (online: the activation's `occurredAt`; upload: the event's `occurred_at`). Same instant as the
  receipt and the `booking.lights_on` webhook's `occurred_at`.
- **Own voice (E18-8):** `TraceFacts.BySelf` (actor is the traced member) → "Their check-in reached the club
  late — no-show reversed". Accepted uploads (`ok`, `reversed_no_show`, `after_cancel`, `displaced_collision`)
  now carry the member as subject so the device activity names them; their verdict rows are
  `TraceKinds.AcceptedVerdictActions` → never a refusal on a Night.
- **Pay-for attendance (E18-6), decided:** a scan stamps only the scanner's own seat — a payer's seat if they
  hold one, never the organiser's. The booking's `CheckedInAt` is whoever lit it (money rule). The booker of
  a seatless game who scans after a payer lit it gets one seatless `court.checked_in` row
  (`SeatCheckIn.StageBookerArrivalAsync`, `participant_id` null), once. **A payer with no accepted seat is not
  a player** (P11: booker or accepted seat; D10 lets a member pay for a court they are not on) — the session is
  not on their play record; their Night carries the payment and the scan. AttendanceQuery unchanged.
- **Member cancel of an own not-open booking (J18-8):** 409 `booking_not_open` / `not_cancellable {status}`,
  as the desk's (a double-tap's losing twin included); a stranger still 404. Code b5dc8044.
- **Escaped 23505 → 503 `conflict_retry` + Retry-After 1** (`InternalErrors.Classify`, walks inner
  exceptions), never 500 — member and device routes alike.
- **One body, one board (D18-5):** `DeviceBody.ReadAsync` refuses (400 `malformed_body`) a body whose top-level
  `mac` appears twice (any case) or differs from the MAC the limiter charged (`DeviceRateKey.ChargedMac`).
- **One checker rule:** `BookingService.CheckedInByAsync` calls `ClubCancelNotices.CheckedInByAsync`.
- **D18-1 verified** on an isolated gateway image from HEAD: anonymous floods 1.5k/3k req/s (keep-alive and
  fresh connections) → 0 × 502, 0 errno 99, members 200. Headroom note: fresh-connection bursts at 3k req/s put
  ~13k of ~28k upstream ports in TIME_WAIT (pool 64 × workers overflows); `keepalive 256` + `listen 80
  backlog=4096` + `worker_connections 8192` cut it to ~4.5k — not applied (not needed to pass, needs a main
  nginx.conf in the image).

## Follow-up, lane FX18 (044e984c, 5477f65e)
- **"N checked in" follows E18-6:** a seatless booking someone else paid for counts the organiser only from
  their own row (`SeatCheckIn.AlreadyRecordedAsync`, now public) — `CheckedInAt` is who lit it, not who came.
  Organiser-paid/club bookings keep `CheckedInAt`; seated games count seat stamps. Test `R18xPlayersCheckedIn*`.
- **Client Night:** a board kind that reads no code (`lights.restored`) never falls back to `subject` →
  "reported by Court N's board"; `admin_inherited` → "when they signed in"; `account.*` rows never fold,
  restores fold only with restores (`nightCopy.actorClause` takes the row as its 5th arg).
