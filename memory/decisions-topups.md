---
name: crusaders-mainframe-decisions-topups
description: "P13: members buy admin-defined minute packages (no cap, no free amount); the purchase lock is all the ITN reads; cancel return and one-hour expiry close abandoned checkouts, reopenable by a late COMPLETE."
type: decision
last_verified: 2026-11-20
---

# Live decisions — buying minutes (packages)

Contract: `docs/specs/minutes-and-packages.md` §3.4–3.7, §4. Spec: `docs/specs/payments-payfast.md`. Code:
`Endpoints/{PackageEndpoints,AdminPackageEndpoints,TopUpEndpoints{,.Abandoned}}.cs`, `Services/PackageShelf.cs`,
`Workers/TopUpExpiryWorker.cs`; screens `pages/TopUp{,Shelf,Status}.tsx` (routes `/wallet/buy[/:purchaseId]`),
`pages/admin/AdminPackages.tsx`. The desk's sales are [`decisions-desk-money.md`](decisions-desk-money.md); what an ITN
must prove before money moves is [`decisions-payfast.md`](decisions-payfast.md).

- **No cap, no block, no admin exemption** (Dean 2026-10-01, §3.6). *Why:* a member buys whole packages the club
  priced; the cap protected nothing and every abandoned checkout counted against it. It REPLACED the R100 blocks and the
  R1000 per-member cap (and the PWA's "R700 of your R1000 used" presets, R4 M4-2, gone with it — no `remaining_zar`
  remains in the frontend).
- **The purchase lock** (`PackageEndpoints.Lock`): package id/name, minutes, list price, discount bps, the discount's
  group, amount — written from the LIVE shelf before PayFast. A `quotedPriceZar` that differs → `409
  package_price_changed`, no row; the screen re-reads the WHOLE shelf (R8 J8-2: a discount gained or lost moves every
  price and the banner, not one) and names the fresh price — never re-prices on its own. The ITN credits
  `pending.Minutes`, checks the amount against `pending.AmountZar`, never reads `minute_packages`. *Why:* an admin edit
  under an open card page must not change what paid money buys.
- **The shelf** (pure): club packages at `floor_cent(list × (10000 − d) / 10000)`, d = the LOWEST discount among the
  member's active groups ([`decisions-groups.md`](decisions-groups.md)); the member's groups' own packages at their own
  price, listed first under the group's name; the saving is against the smallest-minutes item on the member's own shelf,
  rounded down, said one way ("Saves R50.00 (8%)", `packagesCopy.savesWords`). A group with packages cannot be deleted
  (`409 group_has_packages`).
- **Opening shelf** (`MinutePackageSeeder`): 1 h R120, 5 h R550, 10 h R1000, only when the club has never had a
  package. **Packages are retired, never deleted** (purchase rows name them); retiring is a `ConfirmDialog`.
- **Closings** (M4-1): the cancel return `POST /minutes/purchase/{id}/cancel` (own row, idempotent, conditional, no
  mail) and `TopUpExpiryWorker` (`expired`, one hour) are both reopenable by a signed COMPLETE; only the gateway's
  CANCELLED/FAILED/mismatch is terminal. Open checkouts show on the shelf with `expires_at` and cancel optimistically;
  any failed cancel reads the row back (a 404 may be a server without the route); `expired` reads "never finished",
  not "You cancelled".
- **A lost purchase reply is read back from the shelf**: a NEW open checkout = registered but the signed form was lost;
  none = nothing started; unreadable = unknown. Never re-sent. A coded 5xx (`provider_register_failed`,
  `payments_not_configured`) is the club's answer, not a lost reply.
- **A package free at the member's discount is the desk's** (R6 J6-7): PayFast takes no R0.00 (`package_price_zero`),
  so the card says "Free at your discount — ask at the desk" and Continue stays disabled — said before the press, not
  refused after it (`isFreeHere`).
- **The old routes**: `/credit/topup*` are gone except the PayFast ITN `notify_url` `/api/v1/credit/topup/callback` (an
  external contract); the SPA's `/wallet/topup[/:id]` redirects to `/wallet/buy[/:id]` keeping the query
  (`?cancelled=1` is PayFast's only cancel signal). The admin notice kind keeps its code `topup.failed`
  ([`decisions-admin-notices.md`](decisions-admin-notices.md)).
- **The docked pay bar puts the price beside the verb and describes it** (R16 L16-2, `aria-describedby`): one large
  "Continue to PayFast · R120.00" was 308px of a 320 / 200 % screen; before a pick it reads "Pick a package", size md.
- **Accepted gap:** a completion racing a cancel return clears the reason by forcing `FailureReason` modified; no test
  can force the interleaving; the cost is a stale `failure_code`.
