---
name: crusaders-mainframe-decisions-frontend-member-r12
description: "Member screens, review round 12 (lane FC12): the decline question shows no money, Given never reads Bought, a cancel or reversal is one named toast, figures on pull-out."
type: decision
last_verified: 2026-10-03
---

# Live decisions — member screens, review round 12 (lane FC12)

Earlier: `decisions-frontend-member-r11.md`, `decisions-minutes-words.md`.
Specs: `e2e/member-r12-fc12.spec.ts`; tests named `*R12*` / `*.r12.test.tsx`.

- **The Decline question is about declining** (J12-3, `invites/AcceptBody`, `inviteFacts.answerHeading`).
  Asking "decline for good?" the sheet, split pane and `/j/` page are titled "Decline this game?" and
  draw the game only — no share, balance, limit or deadline (they describe a yes). One live region
  says both sentences: final, and "Nothing moves: no minutes leave your wallet." Keep → figures back,
  focus on Decline. *Why:* the walk read "Join this game?" with a pay-by deadline over Decline.
- **Given by the club is never Bought** (J12-1): the activity tiles add a Given tile and the Daily
  money flow chart a Given series (info colour, stacked with Bought) only when the period had one;
  the chart's Bought bar is `top_ups − given` (`walletBuckets.givenMinutes`).
- **Mixed lengths name their length** (J12-2, `usePlayersStep.confirmLines`, `SentenceScope`): one
  length → "On each booking you pay…"; mixed → "On the 15-minute booking…" / "On each of the 2
  15-minute bookings…". Split headings are adjectives ("Each 15-minute booking").
- **A debt is not spendable** (J12-4): the book-for bar says "can spend 0 minutes — 12 minutes below
  zero", never "minus 12" (the wallet card's `spendableLine` rule).
- **One toast per cancellation** (X12-1, contract C1): a frame with `parts` + `cancelled_by` is one
  sentence — "The club cancelled your booking: 30 minutes came back, 15 minutes went back to your
  partners for their shares, so 15 minutes came back to your wallet." For an older server the chip
  holds a lone `cancellation_refund` (+, no share part) up to `CANCEL_MERGE_MS` (1 s) and merges the
  `share_transfer` frame that follows; alone it says the old sentence. `movementSentence` takes a
  4th arg `MovementWho` ({cancelledBy, checkedInBy}).
- **A reversal names the scanner** (E12-2, contract C2): `checked_in_by_name` → "Dan Splitter
  checked in, so the no-show was reversed: …" (and the outage reversal, and share `attended` clauses);
  "you were checked in after all" only when null. Emails/inbox are BE12's.
- **A withdrawal is said** (X12-3): `share_cause: share_returned` → "— they withdrew from the game";
  plain: "15 minutes went back to a partner who withdrew from the game." A withdrawn partner is no
  longer on the booking detail, so `namedShareMovement` falls back to the ledger row's counterparty
  (`to` when the minutes left, `from` when they came) — no new frame field needed.
- **Pull-out states the figure** (X12-4): `DETAIL_PLAYER.withdrawBody(paid)` / `withdrawn(paid)` from
  the seat's `paid_minutes`; nothing paid → "nothing moves".
- **Icons beside wrapping text are `shrink-0`** (L12-2: Attendance, PlayerChips). The invite facts
  grid is one column under `@[16rem]` (rem container query): two columns at 320 / 200 % cut
  "Cou / rt 1" and the organiser's name; the spec checks every word is one line box (a range may
  break at its en dash).
