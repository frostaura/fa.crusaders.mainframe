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
- **A phone OPENS Bookings at the week** (§4.2, Dean's call R7, `useOpenAtWeek`): `<main>` is
  scrolled so the day picker sits under the app bar; first Book cell 555 → 315 at 390x844.
  *Why this, not removal:* nothing is dropped (games strip, invites, notices one swipe up). Once
  per visit, only from scrollTop 0, never on a re-read; phone width only; any date. e2e/member-r7.
  **R8 (X8-1, J8-3):** focus a person put in `<main>` cancels it; the announcer's H1 focus (left at
  y −153, first Tab scrolled back up) is handed to the chosen day for 6 s; `?as=` opens at the
  "Booking for" bar, and the target is re-pinned for 2 s (header/bar settle; scroll anchoring slid it
  19px under the bar) until a touch/wheel/key. e2e/bookings-r8-fd1b.
- **A 402 `insufficient_balance` is adopted** (R7 X7-2): its `current_minutes` (the club's
  SPENDABLE) replaces the sheet's figure while the wallet still says the stale one, and the
  wallet is re-read so the chip follows; an invite Accept's 402 re-reads it too (R8 X8-5). A slot-cap
  409 is said with its figures, joined games counted (R8 J8-1). Games read `sold_ends_at ?? ends_at`.
- **The desk's "book as" picker is lazy** (`BookAsChoice` via `lazyParts`, lane B's perf lead):
  a member's Schedule chunk no longer pulls the member combobox / cmdk; `lazyParts.test` guards it.
- **Split late cancel toast** subtracts the penalty from a `net_credits` equal to gross − partners
  (M5-7) — remove once the server's net counts it (lane F, R5).

## Traps met

- **A sticky box sticks only inside its PARENT**: the week strip's own wrapper scrolled away with it;
  the whole picker (child of the grid's column) is what sticks.
- **Under a modal sheet the grid is aria-hidden** — RTL needs `{ hidden: true }` to see a cell.
- **`test-results/` is shared between lanes** — pass `--output=<own scratch dir>` to Playwright.
