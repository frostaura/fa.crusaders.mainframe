---
name: crusaders-mainframe-decisions-topups
description: "P13: members buy admin-defined minute packages (no cap, no free amount); the purchase lock is all the ITN reads; cancel return and one-hour expiry close abandoned checkouts, reopenable by a late COMPLETE."
type: decision
last_verified: 2026-10-03
---

# Live decisions — buying minutes (packages) and the desk

Contract: `docs/specs/minutes-and-packages.md` §3.4–3.7, §4. Spec: `docs/specs/payments-payfast.md`.
Code: `Endpoints/{PackageEndpoints,AdminPackageEndpoints,TopUpEndpoints{,.Abandoned},WalletEndpoints{,.Desk}}.cs`,
`Services/PackageShelf.cs`, `Workers/TopUpExpiryWorker.cs`; console `pages/TopUp{,Shelf,Status}.tsx`
(routes `/wallet/buy[/:purchaseId]`), `pages/admin/AdminPackages.tsx`, `lib/deskMinutesCopy.ts`.

- **No cap, no block, no admin exemption** (Dean 2026-10-01, §3.6). *Why:* a member buys whole
  packages the club priced; the cap protected nothing and every abandoned checkout counted against it.
- **The purchase lock** (`PackageEndpoints.Lock`): package id/name, minutes, list price, discount bps,
  the discount's group, amount — written from the LIVE shelf before PayFast. A `quotedPriceZar` that
  differs → 409 `package_price_changed`, no row; the screen re-reads the WHOLE shelf (R8 J8-2: a discount gained or lost moves every price and the banner, not one) and names the fresh price — never re-prices on its own.
  The ITN credits `pending.Minutes`, checks the amount against `pending.AmountZar`, never reads
  `minute_packages`. *Why:* an admin edit under an open card page must not change what paid money buys.
- **The shelf** (pure): club packages at `floor_cent(list × (10000 − d) / 10000)`, d = the LOWEST
  discount among the member's active groups; the member's groups' own packages at their own price,
  listed first under the group's name; the saving is against the smallest-minutes item on the
  member's own shelf, rounded down. A group with packages cannot be deleted (409 `group_has_packages`).
- **Opening shelf** (`MinutePackageSeeder`): 1 h R120, 5 h R550, 10 h R1000, only when the club has
  never had a package. Packages are retired, never deleted (purchase rows name them).
- **Closings unchanged** (M4-1): cancel return `POST /minutes/purchase/{id}/cancel` (own row,
  idempotent, conditional, no mail) and `TopUpExpiryWorker` (`expired`, one hour) are both
  reopenable by a signed COMPLETE; only the gateway's CANCELLED/FAILED/mismatch is terminal.
  Open checkouts show on the shelf with `expires_at` and cancel optimistically.
- **A lost purchase reply is read back from the shelf**: a NEW open checkout = registered but the
  signed form was lost; none = nothing started; unreadable = unknown. Never re-sent. A coded 5xx
  (`provider_register_failed`, `payments_not_configured`) is the club's answer, not a lost reply.
- **The desk sells and adjusts as two routes** (§3.7, §12.8): `/admin/minutes/{id}/sell` (sale
  codes, `zarReceived` defaults to the member's shelf price, `AdminTopUp`, change code
  `credit.topped_up` + `package_id`/`package_name`) and `/adjust` (goodwill/correction/refund/other,
  ±999 999 whole minutes, may go negative). *Why:* a sale's package and rand cannot be mixed with
  a signed goodwill amount.
- **The old routes**: `/credit/topup*` are gone except the PayFast ITN `notify_url`
  `/api/v1/credit/topup/callback` (external contract). The SPA's `/wallet/topup[/:id]` redirect to
  `/wallet/buy[/:id]` keeping the query (`?cancelled=1` is PayFast's only cancel signal).
- **A package free at the member's discount is the desk's (R6 J6-7)**: PayFast takes no R0.00
  (`package_price_zero`), so the card says "Free at your discount — ask at the desk" and Continue
  stays disabled — said before the press, not refused after it (`isFreeHere`).
- **Accepted gap:** a completion racing a cancel return clears the reason by forcing
  `FailureReason` modified; no test can force the interleaving; the cost is a stale `failure_code`.
