---
name: technologies-crusaders-squash-control-system-decisions-frontend-book-sheets
description: "Book and Cancel sheets: a money sheet never closes mid-write, only a double tap's tail is ignored, a refusal is taken to the reader, a final refusal ends the sheet, unsure words count the slots."
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
- **Cancel over a checked-in booking** — no member Cancel, who checked in, the shares that stand:
  [`decisions-frontend-book-sheets-checked-in.md`](decisions-frontend-book-sheets-checked-in.md).
- **The Done line follows the live wallet once it has caught up** (R19 J19-2, `BookSheet.useOwnFigureNow`): the
  viewer's own run (`who.kind === "self"`) shows the chip's figure — spendable when anything is held, else the balance —
  from the moment the live wallet equals the answer's `balanceAfter` or a stream frame newer than the SEND arrived
  (`useSentMark`: the frame count is kept current on every render before the send and frozen from it, so a frame
  landing inside the request counts), latched. *Why not always live:* with no page wiring the live figure is the
  PRE-booking one; *why not always the answer:* a club adjustment just after left the line 9 minutes behind. A desk
  booking for a member keeps the answer's figure ("…after this booking").
- **Said once, counted, placed** (R11–R18): a cancel from a booking's page is said once, by the sheet's toast, and focus
  goes to the cancelled banner (`[data-cancelled]`), never `<main>` — the panel unmounts with its trigger
  (`AttendanceAndCancel.tsx:59-64`); a lost-reply cancel toast claims nothing about the screen ("its figures aren't in
  this message — your wallet shows what came back") — *Why:* the booking page re-reads and shows the refund; unsure
  booking sentences are count-aware (R18 X18-5, `refusalSentence(error, withPlayers, forName, slots)`; over one slot
  `UNSURE_MANY_TEXT`, `CONFLICT_UNSURE_MANY_TEXT`, `BOOK_MANY_UNREAD_TEXT` — "the slots are still free", "one of those
  courts"; cancels have no plural sentence, a several-cancel answers row by row); a `503 service_busy` on a booking
  sheet is `SERVICE_BUSY_BOOK_TEXT` unread and `SERVICE_BUSY_UNSURE_TEXT` after the read-back (still read back: a 5xx is
  never a "no"); several slots read in ONE order — start time, then the day's court order (`slotOrder.ts`), bulk rows
  put back in the order sent; no room is said with its figure (`409 too_many_players {free_seats}` → "Only 1 seat is
  still free on this booking — add 1 player, or fewer.").
