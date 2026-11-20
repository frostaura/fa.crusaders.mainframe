---
name: crusaders-mainframe-decisions-frontend-book-sheets
description: "Book and Cancel sheets: a money sheet never closes mid-write, only a double tap's tail is ignored, a refusal is taken to the reader, a final refusal ends the sheet, who checked in is read off the record."
type: decision
last_verified: 2026-11-20
---

# Live decisions — the booking and cancel sheets

The grid: [`decisions-frontend-bookings.md`](decisions-frontend-bookings.md); unsure words:
[`decisions-frontend-unknown-outcomes.md`](decisions-frontend-unknown-outcomes.md).

- **A money sheet stays open while its write is in flight** (R4 I4-1, HIGH: Book on a slow reply → Back → Cancel closed
  the sheet silently and the member was charged). `useSendingGuard` refuses every close (×, Escape, scrim, footer) and
  re-announces; the footer shows the waiting line IN PLACE of Back/Cancel/Keep/Done; `useSheetHistory`'s close may return
  `false` and the entry is pushed back (system Back); an answer after a forced teardown is a toast (`useLateLanding`).
  *Why its own flag:* `action.reset()` on a step change cleared `pending` mid-flight. Book and Cancel sheets both (the
  cancel sheet is also the detail's and the admin member page's); TopUp's Cancel waits while the club registers the payment.
- **After Continue, only a double tap's tail is ignored** (I4-2): `event.detail ≥ 2` within 300 ms, said on the sheet; a
  single tap (1) or a key (0) always books. *Why:* time alone dropped deliberate quick taps silently; the browser's click
  count is the double-tap signal (and touch taps count as a double for ~500 ms, hence the window too).
- **429 on Book/Cancel** is `rateLimitedSentence(retry_after_seconds)` + "nothing was booked / the booking is still
  there" — the limiter refuses before the write, so it is certain.
- **A gone slot is never offered again** (R11 X11-3): after a refusal that proves the slot gone (`provesStaleGrid` minus
  duplicate_request / booking_not_found / block_not_found) the primary is "Pick another time" (`BOOK_SHEET_GONE`),
  focused on mount, closing onto the refreshed grid.
- **A sheet's refusal is taken to the reader** (R18 L18-2, `useRefusalInView`): the alert carries `data-sheet-refusal` +
  `tabIndex=-1` and a task after render is scrolled into view (`block: "nearest"`) and focused — except a gone slot, where
  the keyboard is on "Pick another time" and the refusal is only scrolled to and is that button's `aria-describedby`.
  *Why:* at 320 / 200 % the refusal was below the fold while focus sat on the button just pressed. **A refused reason takes
  the keyboard to the reason** (R16 X16-3, CancelSheet + LiftHoldSheet: a refusal counter → effect →
  `focusFirstComplaint` after the commit that marks the field invalid).
- **A cancel refused for good ends the sheet** (R18 L18-10, `endsCancel`): `booking_not_open`, `not_cancellable`,
  `booking_not_found`, `already_checked_in` drop the quote's figures, the waiver, the reason and Cancel; the way out is a
  primary "Done", headed "Not cancelled" (R19 L19-5), and "The schedule behind this is up to date now" names the place the
  sheet was opened over (schedule · `/bookings/:id` · a member's bookings, read off the route). A rate limit, a missing
  reason or a lost answer keep everything — they can be tried again.
- **No member Cancel once `attendance.checked_in_at` is set** (R15 D15-5), whatever an older `can_cancel` says: the
  member-route CancelSheet refuses up front off the quote's `checkedIn` (a member's, or an admin's own — the server's
  member route is `actorIsAdmin: false`) in `ALREADY_CHECKED_IN_TEXT` (subject-free, `bookingErrors.ts:40-41`), with no
  Cancel to press. The club route is unaffected.
- **Who checked in is read off the booking record, never assumed** (R19 J19-3, `checkedInBy.ts`): the quote has no
  scanner; a player row whose own `checked_in_at` is the SAME instant as `attendance.checked_in_at` lit the court (compared
  as instants); a partner wins, else the organiser; no such row (a pay-for payer lit it) or an unreadable record → nobody
  named ("Someone has already checked in…"). One read per sheet (`useCheckedInRecord`, only when the quote says checked
  in, single booking) feeds the desk sentence, the member's own refusal ("You've" only for their own scan), the
  shares-stand note and the toast; the sentence waits for the record (no swap in a polite region) while Cancel stays
  pressable. Bulk row reason `already_checked_in` is subject-free. A `checked_in_by` quote field would save the read
  (asked; not built).
- **The desk's club cancel says the partners' shares stand, off the record** (R16 J16-7): on a club cancel whose fresh
  quote says `checkedIn`, `CancelSheet` reads `GET /bookings/{id}` and says `ADMIN_CANCEL.sharesStand` (info, polite) —
  the quote's `partner_refunds` is empty when nothing is refunded. Same rule as `AdminCancelPanel`, both through
  `lib/standingShares.ts`. A failed read says nothing about the shares.
- **The Done line follows the live wallet once it has caught up** (R19 J19-2, `BookSheet.useOwnFigureNow`): the
  viewer's own run shows the chip's figure from the moment the live wallet equals the answer's `balanceAfter` or a frame
  newer than the SEND arrived (`useSentMark`), latched. *Why not always live:* with no page wiring the live figure is the
  PRE-booking one; *why not always the answer:* a club adjustment just after left the line 9 minutes behind. A desk
  booking for a member keeps the answer's figure ("…after this booking").
- **Said once, counted, placed** (R11–R18): a cancel from a booking's page is said once, by the sheet's toast, and focus
  goes to the cancelled banner (`[data-cancelled]`); a lost-reply cancel toast claims nothing about the screen ("its
  figures aren't in this message — your wallet shows what came back"); unsure booking sentences are count-aware
  (`refusalSentence(error, withPlayers, forName, slots)`: `UNSURE_MANY_TEXT`, "the slots are still free"); several slots
  read in ONE order — start time, then the day's court order (`slotOrder.ts`), bulk rows put back in the order sent; no
  room is said with its figure (`409 too_many_players {free_seats}` → "Only 1 seat is still free on this booking — add 1
  player, or fewer.").
