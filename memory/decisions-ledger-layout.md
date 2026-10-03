---
name: crusaders-mainframe-decisions-ledger-layout
description: "R5 lane A: the ledger folds by its own box (Amount never lost), its heads stick to the page, top bars stick by room and publish their height, the wallet rail's primary Top up and last 30 days."
type: decision
last_verified: 2026-10-03
---

# Live decisions — the ledger, sticky bars and the wallet rail (review round 5, lane A)

- **LedgerTable folds by `@container/ledger` in rem, never `sm:`** (`wallet/ledgerColumns.ts`):
  Time 36rem, Category 44, From/To 60, Done by 68; a book whose comment is `wideOnly` (the club's)
  draws From/To at 52, Done by at 60, the comment at 84 — *why:* measured in Chromium, every column
  but the comment needs 57.6rem and with it 79rem; at the old 64rem the Amount went off a 70rem
  box (1440/1920 with the movement panel open; the member Wallet tab, 889px in 638).
- **Below a 16rem box the amount rides in the movement's cell** (`StackedAmount`) — *why:* the
  two-column form needs 14.3–15.9rem and a phone at 200 % text is 10.1rem; a pinned column covered
  half the words. jsdom draws both amounts: tests scope to `td.text-right` / `[data-stacked-amount]`.
- **A book that still overflows scrolls inside ScrollArea with Amount + Details pinned right**
  (`right-touch` beside a 44px, unpadded Details column) — only under `[data-scrolls]`.
- **Heads stick to the PAGE** under `--context-bar-top-height`: ScrollArea `onlyWhenWider` is a
  plain box while the table fits; rows' controls carry `scroll-mt-14` for the heads, and the shell's
  `scroll-padding-top` (lane B) covers the bar (X5-2, WCAG 2.4.11).
- **A top bar sticks by ROOM** (`ui/use-sticky-top.ts`): only while it is ≤ `stickyMax` of its
  scroller — Transactions 0.25 (1280: 137/843px; a phone 165/787, so it sticks there too until the
  filters open), Wallet activity's range 0.3 — *why:* `lg:sticky` held a 665px bar over 744px at
  1280/200 %. It publishes its height only while stuck.
- **Report tiles are `AutoGrid stat max=4`**; a figure never breaks inside its number (X5-4).
- **Wallet rail (≥ lg):** Top up is PRIMARY beside the figure at any balance; the last 30 days
  (top-ups, spent, net) from `reportWallet` under it, three states, offline says it needs a connection.
- **Wallet activity reads through D2's kept store** (`useKeptReport`), StaleNotice on a failed refresh.
- **Wallet activity's figures are movements, signed (R7 E7-7/J7-2):** tiles and Totals alike; the
  daily table adds a column per bucket the period moved by (penalties, adjustments, reversals,
  shares — optional on the wire) and a signed Net (`net_movement_minutes`), so a row adds up.
- **A row's Category says what it was, not only its type (R10 E10-5/J10-5, `lib/ledgerCopy.ledgerCategory`)**:
  a `CancellationRefund` reads its stored reason + sign (outage refund / reversed, pay-for, no-show, displaced,
  reinstated; an unknown negative is "Refund reversed") — *why:* an outage reversal of −15 read "Cancellation
  refund". A desk sale names its `zar_paid` ("…, R96.00 received"); a gift "at no charge". The patterns follow the
  server's stored reasons; a reworded reason there needs `REFUND_REASONS` here.
- **R11 E11-5:** a `BookingCharge` whose stored reason begins "Paid at court on behalf of another member" (the
  pay-for's charge leg, stream `pay_for_charge`) reads "Pay-for charge — paid at the court for another member",
  beside its refund leg's "Pay-for refund — …". Same rule: reworded server reason → `PAY_FOR_CHARGE_REASON` here.
