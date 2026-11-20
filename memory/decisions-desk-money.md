---
name: crusaders-mainframe-decisions-desk-money
description: "The desk's money: sell (a package at the confirmed price) and adjust (signed goodwill) are two routes, a key is one member's movement and replays before any shelf check, given minutes are never sold, refunds name their purchase."
type: decision
last_verified: 2026-11-20
---

# Live decisions — money moved at the desk

Contract `docs/specs/minutes-and-packages.md` §3.7, §12.8. Code `Endpoints/WalletEndpoints{,.Desk,.Reversal}.cs`,
`lib/deskMinutesCopy.ts`. Every desk movement is ledger-only and `{actor: admin, subject: member}` (CLAUDE.md).

- **Sell and adjust are two routes.** `/admin/minutes/{id}/sell` (sale codes; `AdminTopUp`; change code
  `credit.topped_up` + `package_id`/`package_name`, codes kept per contract §2.5) and `/adjust` (goodwill / correction /
  refund / other, ±999 999 whole minutes, may go negative). *Why:* a sale's package and rand cannot be mixed with a
  signed goodwill amount.
- **A desk sale carries the price the admin confirmed** (R9 J9-1): `quotedPriceZar` must equal the live shelf price or
  `409 package_price_changed {package, discount}` (the purchase path's answer), nothing posted; a free give whose price
  is no longer 0 is the same 409; neither `quotedPriceZar` nor `zarReceived` → `400 quoted_price_required`;
  `zarReceived` defaults to the member's shelf price and is stated as `ZarPaid` on `AdminTopUp`. *Why:* the server
  filled in the write-time price, so a discount moving between confirm and Sell recorded and mailed R96 for an R108
  confirmation. The console always sends both (0 for a gift).
- **The idempotency key replays BEFORE any price or shelf check** (R10 J10-2, `WalletEndpoints.Desk.ReplayedSaleAsync`):
  a retry after the discount moved or the package retired answered 409, the sheet said "Nothing was recorded", minted a
  new key and sold twice. The package is read by id, archived or not; a changed payload under the key is still
  `idempotency_key_reused`; the answer quotes the price the desk confirmed. **A key is one member's movement** (R11
  J11-1): `WalletEndpoints.Replay` compares `stored.UserId` too — key K on another member's URL had answered 200 with the
  first member's entry. **A replay quotes its own balances** (R17 J17-6, `ReplayBalancesAsync` reads
  `balance_before/after_minutes` off the movement's `credit.adjusted` audit row, else the balance now). *Why:* a raced
  double-click answered from a balance read before its twin committed, and a later replay answered from today's balance.
- **`package_free`** (R7 J7-10): a fourth sell code, valid only on a R0.00 shelf price; rand optional and 0;
  `AdminTopUp` with `ZarPaid` 0; no-charge mail. A R0.00 package may still be sold under a paid code.
- **No rand taken = given, whatever the payment code** (R14 J14-5): `GivenMinutes.IsGiven` (AdminTopUp, `ZarPaid` null
  or 0) is the one rule for reports, the Night and the desk mail (`WalletEndpoints.DeskSaleIsGift` →
  `PackageGivenAtDesk`); the ledger keeps the code as typed; a free package is "Give"/"given" in the console. The
  sell sheet's button and receipt follow `isGiven(flow)` = free package OR R0.00 typed (`SellPackageSheet.tsx`).
- **Given minutes are not sold** (R13 J13-2, R14 J14-2): `/admin/reports/revenue` counts paid funding only in
  `gross_topups_minutes`, `net_minutes` and `zar_per_minute_sold`; gifts are `given_minutes` (additive; sold + given =
  every funding row, so it reconciles with Transactions). `/admin/reports/daily` rows carry `given_minutes` as a SUBSET of
  `top_ups_minutes` (buckets still sum to `net_movement_minutes`); the console's Sold = top-ups − given, and Given is its
  own stat / column / series ("Given by the club") only in a period with a gift. *Why:* the totals card said 3 h sold
  beside a Sales card saying 1 h 45 — one word, one meaning. Member reports carry `given_minutes` as a SUBSET of
  `top_ups_minutes` (AdminTopUp with `ZarPaid` 0), never added to the net (`ReportingEndpoints.cs:572-574`; "Given by
  the club", never "Bought").
- **Rand given back is a `PaymentReversal` naming the purchase** ([`decisions-payfast.md`](decisions-payfast.md)): the
  desk sheet on a member's ⋯ (BM-6) is purchase → amounts → check, rand and minutes asked apart, capped at what
  `/reversible` says is left. **A lost reply re-reads the PURCHASE** (grew by this press → landed; read, not grown →
  absent, key kept; unreadable → unknown) — the reversal names its funding row, so "what has gone back on it" is the
  exact question. Offered to any member with a membership: a suspended member's refund still nets revenue. Adjust, Sell
  and Refund share `DeskConfirmFooter`.
- **A take-back says when it leaves less than a court** (R11 J11-2): balance − amount − held − owed back vs
  `slice_minutes`, in the mail's words (`shortOfCourtLine`); `useTakeBackRoom(userId)` reads them — unknown → no line;
  below zero the overdraft warning speaks. Callers must pass `TopUpSheet userId`.
- **The Sell sheet after a 409** (R10): the body's `discount` goes on the header with the package, the shelf is re-read
  quietly (the chosen package keeps the 409's price — the server judges the next press); the notice is said ONCE (the
  Sell button's live region on the check; itself only when a gift became paid and the step changed —
  `SellPackageSheet.tsx:118-126,303`), scrolled into view, and focus lands on Sell (`saleFocus.ts`: Radix parks focus on
  the dialog container when the armed confirm unmounts, which `ConfirmButton`/`focusAfterAction` do not treat as
  adrift). The sheet cannot close mid-credit ([`decisions-admin-lost-replies.md`](decisions-admin-lost-replies.md)).
- **A desk movement naming a booking reconciles shares at the call site** (the share sweep looks back a week only), and
  an admin adjustment naming a booking is how a no-show is compensated ([`decisions-settlement.md`](decisions-settlement.md)).
- **Reports:** `penalty_count` counts bookings whose penalty rows net to a debit (a returned penalty is none);
  `/reports/me/daily` carries every wallet-report bucket plus `net_movement_minutes`, so a day row adds up.
