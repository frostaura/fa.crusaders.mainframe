---
name: crusaders-mainframe-decisions-frontend-bookings-r5
description: "Bookings, review round 5 (lane C): every price is the payer's group price, a hold lift asks why, too-far-ahead and offline cells are drawn as such, closed runs fold, the phone's week sticks."
type: decision
last_verified: 2026-10-03
---

# Live decisions — the Bookings grid and Book sheet (review round 5, lane C)

Earlier rounds: `decisions-frontend-bookings.md`, `-r4.md`. Tests: `pages/bookings-group-price|bookings-r5`,
`e2e/bookings-r5`.

- **Every price on the grid is the PAYER's, never the court's** (I5-1, HIGH). `lib/viewerPrice`:
  the server's per-court figures first (`rules.slicePricesByCourt` — asked of lane F; the desk's
  member read already sends `slice_prices_by_court`), else `rules.slicePriceCredits` on its
  REFERENCE court (schedule: first open court by number; desk member read: the cheapest), derived
  for other courts (same price → group price; group = reference → court's own; else a ratio).
  *Why:* group 30 / court 50 / 40 to spend said "need 10 more" and disabled Book; the club takes it.
  Booking FOR a member prices at the member's rules. Slots carry it (`toSelectedSlots(…, priceOf)`).
- **Lifting a club hold confirms and takes a required reason** (A5-1, `LiftHoldSheet`), sent as
  `adminUnblock(id, reason)` → `?reason=`. The lift itself stays optimistic.
- **A slot past now + the club's `advanceBookingDays` is "Not open yet"** (`CellFacts.notYetOpen`,
  reason `too_far_ahead`), for the desk too — the API refuses both. Test fixtures dated 2030 carry
  `advanceBookingDays: 3650` (bookingsKit, schedule-quota-groups); a new 2030 fixture needs it too.
- **Offline (the phone's copy) a free cell is muted "Free", no price** (V5-8, `BoardContext.offline`).
- **4+ closed rows nothing is booked in fold into one row** "00:30–06:00" (V5-5, `TimeSlice.folded`).
- **Booking for a member, the rail's wallet is theirs** (A5-9) — no Top up.
- **Phone layout** (§4.2): upcoming, recent and the invites chip are ONE sideways strip (the lists
  inside lie flat); the day picker sticks under the app bar when it is ≤ 40 % of `<main>` and
  publishes `--day-strip-height`, which the grid's scroller subtracts. The grid frame is
  `relative z-base` so its sticky court header never paints over the strip.
- **Desktop**: the selection bar spans the grid frame from 1024px (V5-10, ActionBar `style`); from
  3xl the main column hugs the capped grid (F5-6, `HUG_GRID`); the rail's day summary says
  "You can book N more slots today" under a cap, today only, never for an admin (exempt) (§3.1).
- **No `?date=`: the club's today, adopted from the first answer** (R6-CI-1, `useScheduleDay`
  `toClubToday`) — *why:* `lib/clubZone` is memory only, so a cold start guessed the READER's day;
  New York at 23:50 UTC opened a UTC club's yesterday, every cell past. A day asked for stays.
- **The phone's first Book cell is ~555px down at 390, not ≤360** (R6, measured): header 81–145,
  games strip 177–277, picker 297–418, court chips, grid header 495–551. 360 needs a product call
  (drop/relocate the strip, chips or month row, or scroll to the grid on open).
- **The desk's "book as" picker is lazy** (`BookAsChoice` via `lazyParts`, lane B's perf lead):
  a member's Schedule chunk no longer pulls the member combobox / cmdk; `lazyParts.test` guards it.
- **Split late cancel toast** subtracts the penalty from a `net_credits` equal to gross − partners
  (M5-7) — remove once the server's net counts it (lane F, R5).

## Traps met

- **A sticky box sticks only inside its PARENT**: the week strip's own wrapper scrolled away with it;
  the whole picker (child of the grid's column) is what sticks.
- **Under a modal sheet the grid is aria-hidden** — RTL needs `{ hidden: true }` to see a cell.
- **`test-results/` is shared between lanes** — pass `--output=<own scratch dir>` to Playwright.
