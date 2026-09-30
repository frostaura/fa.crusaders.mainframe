---
name: crusaders-mainframe-decisions-frontend-bookings-r4
description: "Bookings and top-up, review round 4 (lane F1): a money sheet never closes mid-write, only a double tap's tail is ignored, the page re-reads on wallet-stream moves, top-up honours what is left."
type: decision
last_verified: 2026-09-30
---

# Live decisions — money sheets, Bookings liveness and top-up (review round 4, lane F1)

Earlier rounds: `decisions-frontend-bookings.md`. Tests: `components/bookings/__tests__/
inflight|scheduleLiveness|lazyParts`, `pages/TopUp.remaining|TopUpStatus.cancel`, `e2e/bookings-r4`.

- **A money sheet stays open while its write is in flight** (I4-1, HIGH: Book on a slow reply →
  Back → Cancel closed the sheet silently and the member was charged). `useSendingGuard` refuses
  every close (×, Escape, scrim, footer) and re-announces; the footer shows the waiting line IN
  PLACE of Back/Cancel/Keep/Done; `useSheetHistory`'s close may return `false` and the entry is
  pushed back (system Back); an answer after a forced teardown is a toast (`useLateLanding`).
  *Why its own flag:* `action.reset()` on a step change cleared `pending` mid-flight. Book and
  Cancel sheets both (the cancel sheet is also the detail's and the admin member page's);
  TopUp's Cancel waits while the club registers the payment.
- **After Continue, only a double tap's tail is ignored** (I4-2): `event.detail ≥ 2` within
  300 ms, said on the sheet. A single tap (1) or a key (0) always books. *Why:* time alone
  dropped deliberate quick taps silently; the browser's click count is the double-tap signal.
- **429 on Book/Cancel** is `rateLimitedSentence(retry_after_seconds)` + "nothing was booked /
  the booking is still there" (I4-3): the limiter refuses before the write, so it is certain.
- **Bookings re-reads what others change** (M4-3, `useScheduleLiveness`): on a wallet-stream
  move (balance or unread; the first figures are a load) and on return to view with a read
  > 10 s old. A move within 3 s of the page's own write is its echo and is skipped.
- **A pick past the daily cap is said in the selection bar** (M4-7, short form; the screen
  reader hears the full rule, which names what is chosen, never "You can book N more").
- **The group rate line shows only when the group changes the price** (I4-7): the group price
  (`rules.slicePriceCredits`) against the first open court's own price, the name as written, no
  figure; several groups → "your groups' rate" (the server does not say whose).
- **The calendar is a fluid 7-column grid of squares ≤ 56 px** (X4-3); no rem cell widths.
- **Lazy: CancelSheet (mounted at first open, idle-fetched once the day shows), SplitStep
  (fetched when a share is asked), WalletActivity's charts** — a value import brings them back;
  `lazyParts.test` / `walletActivity-lazy.test` guard it.
- **Top-up offers only what is left** (M4-2): presets ≤ `remaining_zar`, the limits line says
  "R700 of your R1000 used", nothing left → no form; a cap refusal's figures are taken in.
  Admins keep the per-payment max. **The cancel return tells the club** (M4-1 page half,
  `topupCancel`); ANY failure reads the row back (a 404 may be a server without the route);
  `expired` reads "never finished", not "You cancelled".

## Traps met

- **The harness's `respond` cannot be async** — for a slow reply, wrap `globalThis.fetch` after
  `stubFetch` and gate POSTs on a promise (`inflight.test`'s `holdPosts`).
- **Touch taps count as a double tap for ~500 ms** (Playwright: a 350 ms gap is still
  `detail` 2) — which is why the tail rule also needs the 300 ms window.
- **The Wallet ledger at 390/200 % scrolls sideways inside its ScrollArea** (the amount column
  is off-screen until swiped) — by the table's own design; a stacked phone layout is not built.
