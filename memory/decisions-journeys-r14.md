---
name: crusaders-mainframe-decisions-journeys-r14
description: "Journeys, review round 14 (lane FE14j): Sold on Reports is paid only with Given apart, a R0.00 desk sale is a gift everywhere, partners named and counted, a first ask is not 'went up', one first-result badge."
type: decision
last_verified: 2026-10-05
---

# Live decisions — journeys, review round 14 (lane FE14j)

Earlier: `decisions-backend-r13a.md` (given minutes are not sold), `decisions-frontend-member-r13.md`.

- **"Sold" on the club's Reports is paid minutes only, everywhere** (J14-2). `/admin/reports/daily`
  rows carry `given_minutes`, a SUBSET of `top_ups_minutes` (desk `package_free` or any AdminTopUp
  with `ZarPaid` 0) — the buckets still sum to `net_movement_minutes`. The totals card, the daily
  table's Sold column, "Minutes sold over time" and the flow chart draw top-ups − given
  (`givenMinutes()`, missing field = 0). Given is its own stat / column / series ("Given by the
  club" on the chart) ONLY in a period with a gift, and the net sentence then says "sold + given
  − …". *Why:* the totals card said 3 h sold beside a Sales card saying 1 h 45; one word, one meaning.
  The totals card picks 5/4/3 columns by whichever divides the figure count (`wholeRows`).
- **No rand taken = given, whatever the payment code** (J14-5). The member's mail picks
  `PackageGivenAtDesk` when `ZarPaid == 0` OR `package_free` (`WalletEndpoints.DeskMailAsync`);
  the sell sheet's button and receipt follow `isGiven(flow)` = free package OR R0.00 typed. The
  ledger keeps the payment code as typed. Change record and Night already read `ZarPaid` (R8 E8-5).
- **The organiser's cancel note names each member partner** (J14-7): live `kind: member` seats,
  `seatName` names, `DETAIL_CANCEL.partnersBack(names)` — singular for one, `listNames` for more,
  empty (penalty line only) when only guests / open seats remain. Guests and open seats hold no share.
- **"Your share went up" needs something agreed first** (J14-9): `needs_consent` with
  `consented_minutes > 0` → `askedAgain`; with 0 (the club accepted the seat without asking) →
  `DETAIL_PLAYER.askedFirst`: "The club has asked you for 12 minutes — review it to say yes."
  The whole class keys on consent: invite card / heading / title (`inviteFacts.neverAgreed` →
  `statusAskedFirst`, `askedFirstTitle`, `askedFirstLine`; reads optional `consented_minutes`, which
  BE was asked to add to the invite view — absent = old words); the change-split notice
  (`splitDoneWords`: again / first / both, consent read off the booking before the change). The seat
  chip and money row were already right via `statusKey` → `not_agreed`; pinned, not changed.
- **One first-result badge, reworded, not split** (J14-11): `first_result` is earned by the first
  confirmed result the member played in, recording OR confirming (`BadgeRules`). Description:
  "Your first match result is on the record." Splitting would need a second rule, a catalogue
  `Version` bump (re-evaluates every member) and a badge nobody asked for. `docs/specs/play.md`
  §5.6's table still has the old sentence — an integrator doc delta.
- Tests (each seen red first): `R14DailyGivenMinutesTests`, `R14BadgeWordsTests`,
  `DeskSaleHttpTests.A_sale_recorded_at_no_rand_…`, `Charts.r14.test.tsx`, `AdminReports.test.tsx`
  (R14 block), `SellPackageSheet.r14.test.tsx`, `players/__tests__/detailR14.test.tsx`, `consentWordsR14.test.tsx`.
