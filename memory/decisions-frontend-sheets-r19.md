---
name: crusaders-mainframe-decisions-frontend-sheets-r19
description: "R19 FE19j: the book sheet's Done line follows the live wallet once caught up; cancel sheets name whoever's scan lit the court, or nobody."
type: decision
last_verified: 2026-10-06
---

# Live decisions — booking and cancel sheets, review round 19 (lane FE19j)

Tests: `components/bookings/__tests__/doneLineLiveR19`, `cancelCheckedInByR19`, `e2e/sheets-r19-fe19j`.

- **The Done line follows the live wallet, once it has caught up** (J19-2, `BookSheet.useOwnFigureNow`).
  The viewer's own run (`who.kind === "self"`) shows the chip's figure — spendable when anything is held,
  else the balance — from the moment the live wallet equals the answer's `balanceAfter` (Schedule's
  `applyBalance`) or a stream frame newer than the SEND has arrived (`useSentMark`: the frame count is kept
  current on every render before the send and frozen from it, so a frame landing inside the request counts,
  as `apply`'s own `sentAt` rule does). Latched once following. *Why not "live always":* with no page
  wiring (the unit suites) the live figure is the PRE-booking one; *why not "the answer always":* a club
  adjustment just after it left the line 9 minutes behind the chip. A desk booking for a member keeps the
  answer's figure, worded "…after this booking" — that wallet is not live here.
- **Who checked in is read off the booking record, never assumed** (J19-3, `components/bookings/checkedInBy.ts`).
  The quote has no scanner. A player row whose own `checked_in_at` is the SAME instant as
  `attendance.checked_in_at` lit the court (activation and late-upload reversal stamp the seat with the
  booking's instant); a partner wins, else the organiser (seat, or the seatless organiser row, which reads
  the booking instant only when a player lit it — R19 E19-3). No such row (a pay-for payer lit it) or an
  unreadable record → nobody named ("Someone has already checked in…"). Compared as instants, not strings.
- **The sentence waits for the record** (no organiser-then-partner swap in a polite region); the cancel stays
  pressable meanwhile. One read per sheet (`useCheckedInRecord`, only when the quote says checked in, single
  booking) feeds the desk sentence, the member's own refusal ("You've" only for their own scan,
  `refusedCheckedIn`), the shares-stand note (R16 J16-7) and the toast (`toastSubject`: the scanner or null
  in `cancellationOutcome`'s nothing-back branch; the organiser where minutes moved). Bulk row reason
  `already_checked_in` is subject-free.
- Fixtures that leaned on the old default stamp the organiser's seat at the booking's instant.
- Asked (integrator): `ALREADY_CHECKED_IN_TEXT` (the 409's words) to go subject-free; optional quote field
  `checked_in_by` so the sheet can skip its record read.
