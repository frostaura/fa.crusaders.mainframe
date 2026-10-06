---
name: crusaders-mainframe-decisions-frontend-shell-r18
description: "R18 FE18s: sheet refusals scrolled to and focused; final cancel refusals end the sheet; multi-slot and service_busy words; club-zone stale label; px boxes at 200 %."
type: decision
last_verified: 2026-10-06
---

# Live decisions — bookings sheets, errors, offline label, tour (review round 18, lane FE18s)

- **A sheet's refusal is taken to the reader** (L18-2, `components/bookings/useRefusalInView.ts`):
  the alert carries `data-sheet-refusal` + `tabIndex=-1`; a task after it renders it is scrolled
  into view (`block: "nearest"`) and focused. *Except* a gone slot: R11 X11-3 puts the keyboard on
  "Pick another time", so there the refusal is only scrolled to and is that button's
  `aria-describedby` (`${reasonId}-refusal`). *Why:* at 320 / 200 % the refusal was below the fold
  while focus sat on the button just pressed.
- **A cancel refused for good ends the sheet** (L18-10, `endsCancel`): `booking_not_open`,
  `not_cancellable`, `booking_not_found`, `already_checked_in` drop the quote's figures, the waiver,
  the reason and Cancel; the way out is a primary "Done". A rate limit, a missing reason or a lost
  answer keep everything — they can be tried again.
- **Unsure booking sentences are count-aware** (X18-5): `BookingErrorContext.slots`;
  `refusalSentence(error, withPlayers, forName, slots)`. Over one slot: `UNSURE_MANY_TEXT`,
  `CONFLICT_UNSURE_MANY_TEXT`, `BOOK_MANY_UNREAD_TEXT` ("the slots are still free", "one of
  those courts"). Cancels have no plural sentence (a several-cancel answers row by row).
- **`503 service_busy` is busy, not down** (BE18s client): `SERVICE_BUSY_CAUSE` "…very busy right
  now. Try again in a moment." — never "down or restarting… give it a minute"; not a deployment
  fault (Try again stays). `PASSING_CAUSES` holds the 503s that pass by themselves
  (`conflict_retry`, `service_busy`). Booking sheets: `SERVICE_BUSY_BOOK_TEXT` (unread) and
  `SERVICE_BUSY_UNSURE_TEXT` (after the read-back; still read back, a 5xx is never a "no").
- **The offline "showing what we had at" is club time** (X18-3): `asOfLabel` = `clubRowTime`, the
  kept club zone (R17 X17-5) for the clock AND for whether it is today.
- **A returned penalty is "… returned" in the desk's booking picker** (E18-9):
  `recentBookingsFrom(rows, label)`; RelatedBookingField passes `ledgerCategory`.
- **Boxes beside words at 200 % are px, and step aside in a rem container** (L18-1/3): the sheet
  tile's racquet box is an inline 40 px and hides under a 12rem row; a time range is
  `whitespace-nowrap` so "21:00–21:30" never splits; Split inputs are `calc(7ch + 1.5rem)` and the
  name goes above under a 16rem card; mode toggles `repeat(auto-fit,minmax(min(100%,5rem),1fr))`.
  `theme-vocabulary` bans arbitrary `w-[…]`, so a px/ch width is an inline style.
- **`overflow-wrap:anywhere`, never `break-all`** (L18-5): break-all splits words that fit a line.
- **The tour's anchor is clamped into the visible band** (L18-6, `clampedRect`): Radix `sticky`
  shifts only on the alignment axis, so a side="bottom" mark rode a scrolled section bar off the
  top (−368 px). Past an edge the rect is a zero-height line at that edge; the outline stays on
  the real control.
- Proof: `e2e/sheets-r18-fe18s.spec.ts` (22 green, mobile + desktop; 7 red before on mobile),
  `components/bookings/__tests__/sheetsR18.test.tsx`, `lib/errors.serviceBusy.r18.test.ts`,
  `lib/offline/asOfClubZone.r18.test.ts`, `components/members/relatedBookingReturned.r18.test.tsx`.
