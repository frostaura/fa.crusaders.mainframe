---
name: crusaders-mainframe-decisions-frontend-bookings
description: "Bookings screen (R2 lane F1): only the latest schedule read lands, ?as= draws the member's windows, finished games live under Recent, 4xx refusals get no retry, held parts per deadline."
type: decision
last_verified: 2026-09-30
---

# Live decisions — the Bookings screen (review round 2, lane F1)

Each came from a round-2 finding reproduced on the running app; the pinning tests are
`lib/scheduleDay.test.tsx`, `pages/bookings-review-r2.test.tsx` and `e2e/bookings-r2.spec.ts`.

- **Only the latest schedule read may touch the day, the error or the spinner** (F1-2). A reply for
  a day the member has left is dropped; a background re-read (`reconcile`) lands on screen only
  while its day is still shown, but still resolves to the sheet that asked. *Why:* Tuesday's slow
  reply replaced Wednesday's day and the page, which draws only the day asked for, drew nothing.
- **`useScheduleDay().error` is the failure itself, never a sentence** (F4-17). *Why:* `StateBlock`
  words it; a pre-worded string was worded again as an unknown throw — a 503 read "something went
  wrong" on Bookings and "down or restarting" everywhere else.
- **`?as=<member>` draws that member's group windows on the grid** (F1-3), from
  `/admin/members/{id}/booking-rules?day=` (`memberGridRules`). God mode lifts credit and the daily
  cap, never a window. Unknown rules (read failed, no `allowed_windows`) offer every cell. The
  locked cell and its sentence are about the member ("outside Naledi's booking times"), not "you".
- **Finished games live under "Recent games"** (F1-1, contract C3 `GET /me/bookings/recent`): each
  opens its booking; a recordable one links `?result=record`, one awaiting the viewer
  `?result=confirm` (`recentAction`). The viewer's own past cells on the grid are links to the
  booking. *Why:* a finished game was on no screen, so its result was reachable only by email.
  `bookingsApi.recent()` is also what ProfileResults' "record a result" list should read (F2-17).
- **A 4xx refusal on the admin quote gets no Try again** (`worthRetrying`, F1-4) — only a failure
  to hear back, 5xx, 408 or 429 does. The server's window refusal sends a day KEY ("wed"), read as
  "Wednesday".
- **A cap-locked cell says "Your limit" with a gauge, never "Full" with a lock** (F1-6) — the court
  is free; the name says the shown day unless it is today (F1-5).
- **Held credit is explained per share deadline** (C4, F4-18's book-sheet half): `heldPartsOf`
  reads `held_parts` (wire) or `parts` (parsed balance figures); more than one part shows
  "Held: 25.00 cr until … · 35.00 cr until …", else the single `held_until` line stands.
- **Forced colours: the week strip's chips opt out (`forced-color-adjust: none`) and draw in system
  colours** — selected Highlight, past borderless GrayText, today a CanvasText ring; the current
  court chip is Highlight (F1-11). *Why:* ToggleGroup items are `role=radio` with
  `data-state="on"`, which index.css's forced-colours rule (`data-state="checked"`) never matched.
- **The player picker moves focus itself** (F1-9): heading on open, the seat's Remove after a pick,
  the seat's Add after Back — the step's body is swapped, so the focused node vanishes otherwise.
- **The phone's week-strip caption uses short months ("Sep – Oct 2026") and never `break-words`**
  (F1-10): at 200 % text "September" broke mid-word beside the arrows.
